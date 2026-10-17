import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { after, test } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

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

const settingsRoot = await mkdtemp(join(tmpdir(), "palui-auth-test-"));
const previousRoot = process.env.PALUI_SERVER_DIR;
process.env.PALUI_SERVER_DIR = settingsRoot;
await mkdir(join(settingsRoot, "defaults"));
await Promise.all([
  writeFile(join(settingsRoot, "defaults/compose.env"), "#|ADMIN_PASSWORD|PASSWORD|Admin password\nADMIN_PASSWORD=adminPasswordHere\n"),
  writeFile(join(settingsRoot, "defaults/system.env"), ""),
  writeFile(join(settingsRoot, "defaults/game_server.env"), ""),
  writeFile(join(settingsRoot, "defaults/game_features.env"), ""),
  writeFile(join(settingsRoot, "defaults/game_balance.env"), ""),
  writeFile(join(settingsRoot, "defaults/game_performance.env"), ""),
]);

const { authCookie, authenticate, getAuthState, isSameOriginRequest, readSession, setupPasswords } = await import("../../lib/server/auth.ts");

after(async () => {
  if (previousRoot === undefined) delete process.env.PALUI_SERVER_DIR;
  else process.env.PALUI_SERVER_DIR = previousRoot;
  await rm(settingsRoot, { recursive: true, force: true });
});

function sessionCookie(role = "operator") {
  const payload = Buffer.from(JSON.stringify({ role, exp: Math.floor(Date.now() / 1000) + 60 })).toString("base64url");
  const secret = process.env.AUTH_COOKIE_SECRET || "palui-development-cookie-secret-change-me";
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${authCookie.name}=${payload}.${signature}`;
}

test("password setup saves plain env values and authenticates each role", async () => {
  assert.equal((await getAuthState()).configured, false);
  await assert.rejects(setupPasswords("", "operator"), /パスワードを入力してください/);

  await setupPasswords("adminPasswordHere", "b");
  assert.equal((await getAuthState()).configured, true);
  assert.equal((await authenticate("admin", "adminPasswordHere"))?.role, "admin");
  assert.equal((await authenticate("operator", "b"))?.role, "operator");
  assert.equal(await authenticate("admin", "wrong"), null);

  const content = await readFile(join(settingsRoot, ".env"), "utf8");
  assert.match(content, /ADMIN_PASSWORD="adminPasswordHere"/);
  assert.match(content, /OP_PASSWORD="b"/);
  assert.doesNotMatch(content, /PASSWORD_HASH/);
  await assert.rejects(readFile(join(settingsRoot, ".passwd")), { code: "ENOENT" });
  await assert.rejects(setupPasswords("again", "again"), /既に設定されています/);
});

test("API sessions require a valid signed role and expiry", () => {
  const signedSession = sessionCookie().slice(authCookie.name.length + 1);
  assert.equal(readSession(signedSession), "operator");
  assert.equal(readSession("invalid"), null);
  assert.equal(readSession(undefined), null);
});

test("same-origin checks support trusted reverse-proxy forwarding headers", () => {
  const request = new Request("http://palui:3000/api/server/lifecycle", {
    headers: {
      host: "palui:3000",
      origin: "https://pal.example",
      "x-forwarded-host": "pal.example",
      "x-forwarded-proto": "https",
    },
  });
  assert.equal(isSameOriginRequest(request), true);

  const crossOrigin = new Request("http://palui:3000/api/server/lifecycle", {
    headers: {
      host: "palui:3000",
      origin: "https://attacker.example",
      "x-forwarded-host": "pal.example",
      "x-forwarded-proto": "https",
    },
  });
  assert.equal(isSameOriginRequest(crossOrigin), false);
});

test("mutating routes can reject missing sessions and cross-origin requests", () => {
  const missingSession = new Request("http://localhost/api/server/overview", {
    method: "POST",
    headers: { origin: "http://localhost" },
  });
  assert.equal(readSession(undefined), null);
  assert.equal(isSameOriginRequest(missingSession), true);

  const crossOrigin = new Request("http://localhost/api/server/lifecycle", {
    method: "POST",
    headers: { cookie: sessionCookie(), origin: "https://attacker.example" },
  });
  assert.equal(readSession(sessionCookie().slice(authCookie.name.length + 1)), "operator");
  assert.equal(isSameOriginRequest(crossOrigin), false);
});