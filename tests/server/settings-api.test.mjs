import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";

const secret = "settings-api-test-secret";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith(".") && !/\.[a-z]+$/i.test(specifier)) {
      for (const extension of [".ts", ".js"]) {
        const url = new URL(`${specifier}${extension}`, context.parentURL);
        if (existsSync(fileURLToPath(url))) return nextResolve(url.href, context);
      }
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith("file:") && url.endsWith(".ts")) {
      const source = readFileSync(fileURLToPath(url), "utf8");
      return {
        format: "module",
        shortCircuit: true,
        source: ts.transpile(source, { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }),
      };
    }
    return nextLoad(url, context);
  },
});

function sessionCookie(role) {
  const payload = Buffer.from(JSON.stringify({ role, exp: Math.floor(Date.now() / 1000) + 60 })).toString("base64url");
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  return `palui_session=${payload}.${signature}`;
}

function request(role, method = "GET", body, origin = "http://palui") {
  return new Request("http://palui/api/settings", {
    method,
    headers: {
      ...(role ? { cookie: sessionCookie(role) } : {}),
      ...(method === "POST" ? { "content-type": "application/json", host: "palui", ...(origin ? { origin } : {}) } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

test("settings API restricts compose settings to admins", async () => {
  const settingsRoot = await mkdtemp(join(tmpdir(), "palui-settings-api-"));
  const previousRoot = process.env.PALUI_SERVER_DIR;
  const previousSecret = process.env.AUTH_COOKIE_SECRET;
  process.env.PALUI_SERVER_DIR = settingsRoot;
  process.env.AUTH_COOKIE_SECRET = secret;

  try {
    await mkdir(join(settingsRoot, "defaults"));
    await Promise.all([
      writeFile(join(settingsRoot, "defaults/compose.env"), "#|ADMIN_PASSWORD|PASSWORD|Admin password\nADMIN_PASSWORD=default-secret\n"),
      writeFile(join(settingsRoot, "defaults/system.env"), "#|UPDATE_ON_BOOT|BOOL|Update on boot\nUPDATE_ON_BOOT=true\n"),
      writeFile(join(settingsRoot, "defaults/game_server.env"), ""),
      writeFile(join(settingsRoot, "defaults/game_features.env"), ""),
      writeFile(join(settingsRoot, "defaults/game_balance.env"), ""),
      writeFile(join(settingsRoot, "defaults/game_performance.env"), ""),
      writeFile(join(settingsRoot, ".env"), "ADMIN_PASSWORD=private-current-secret\n"),
      writeFile(join(settingsRoot, "override.env"), "UPDATE_ON_BOOT=true\n"),
    ]);

    const { GET, POST } = await import("../../app/api/settings/route.ts");

    assert.equal((await GET(request(null))).status, 401);
    assert.equal((await POST(request(null, "POST", { values: {}, expectedHash: "" }))).status, 401);

    const operatorResponse = await GET(request("operator"));
    assert.equal(operatorResponse.status, 200);
    const operatorSettings = await operatorResponse.json();
    assert.ok(operatorSettings.categories.some((category) => category.category === "system"));
    assert.ok(operatorSettings.categories.every((category) => category.category !== "compose"));
    assert.equal(JSON.stringify(operatorSettings).includes("private-current-secret"), false);

    const rejectedCompose = await POST(request("operator", "POST", {
      values: { ADMIN_PASSWORD: "operator-attempt" },
      expectedHash: operatorSettings.hash,
    }));
    assert.equal(rejectedCompose.status, 403);
    assert.equal(await readFile(join(settingsRoot, ".env"), "utf8"), "ADMIN_PASSWORD=private-current-secret\n");

    const rejectedMixed = await POST(request("operator", "POST", {
      values: { ADMIN_PASSWORD: "operator-attempt", UPDATE_ON_BOOT: "false" },
      expectedHash: operatorSettings.hash,
    }));
    assert.equal(rejectedMixed.status, 403);
    assert.equal(await readFile(join(settingsRoot, "override.env"), "utf8"), "UPDATE_ON_BOOT=true\n");

    const otherSetting = await POST(request("operator", "POST", {
      values: { UPDATE_ON_BOOT: "false" },
      expectedHash: operatorSettings.hash,
    }));
    assert.equal(otherSetting.status, 200);
    const savedOperatorSettings = await otherSetting.json();
    assert.ok(savedOperatorSettings.categories.every((category) => category.category !== "compose"));
    assert.match(await readFile(join(settingsRoot, "override.env"), "utf8"), /UPDATE_ON_BOOT="false"/);

    const crossOrigin = await POST(request("operator", "POST", { values: {}, expectedHash: savedOperatorSettings.hash }, "https://attacker.example"));
    assert.equal(crossOrigin.status, 403);
    const missingOrigin = await POST(request("operator", "POST", { values: {}, expectedHash: savedOperatorSettings.hash }, null));
    assert.equal(missingOrigin.status, 403);

    const adminSettings = await GET(request("admin"));
    assert.equal(adminSettings.status, 200);
    const adminData = await adminSettings.json();
    assert.ok(adminData.categories.some((category) => category.category === "compose"));

    const adminSave = await POST(request("admin", "POST", {
      values: { ADMIN_PASSWORD: "admin-updated" },
      expectedHash: adminData.hash,
    }));
    assert.equal(adminSave.status, 200);
    assert.match(await readFile(join(settingsRoot, ".env"), "utf8"), /ADMIN_PASSWORD="admin-updated"/);
  } finally {
    if (previousRoot === undefined) delete process.env.PALUI_SERVER_DIR;
    else process.env.PALUI_SERVER_DIR = previousRoot;
    if (previousSecret === undefined) delete process.env.AUTH_COOKIE_SECRET;
    else process.env.AUTH_COOKIE_SECRET = previousSecret;
    await rm(settingsRoot, { recursive: true, force: true });
  }
});