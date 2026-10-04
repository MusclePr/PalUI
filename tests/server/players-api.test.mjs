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

const secret = "players-api-test-secret";
const serverDirectory = await mkdtemp(join(tmpdir(), "palui-players-api-"));
const previousServerDirectory = process.env.PALUI_SERVER_DIR;
const previousSecret = process.env.AUTH_COOKIE_SECRET;
process.env.PALUI_SERVER_DIR = serverDirectory;
process.env.AUTH_COOKIE_SECRET = secret;
await mkdir(join(serverDirectory, "palworld"), { recursive: true });
await writeFile(join(serverDirectory, "palworld", ".paused"), "");
await writeFile(join(serverDirectory, "players.json"), JSON.stringify([{ id: "steam_legacy", displayName: "Legacy" }]));

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "next/server") {
      const source = "export const NextResponse = { json: (body, init) => Response.json(body, init) };";
      return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true };
    }
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

function sessionCookie() {
  const payload = Buffer.from(JSON.stringify({ role: "admin", exp: Math.floor(Date.now() / 1000) + 60 })).toString("base64url");
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  return `palui_session=${payload}.${signature}`;
}

function request(body) {
  return new Request("http://palui/api/players", {
    method: "POST",
    headers: { cookie: sessionCookie(), "content-type": "application/json", host: "palui" },
    body: JSON.stringify(body),
  });
}

const { GET, POST } = await import("../../app/api/players/route.ts");

test("players API persists userId and ignores legacy identifier formats", async () => {
  const before = await GET(new Request("http://palui/api/players", { headers: { cookie: sessionCookie() } }));
  assert.equal(before.status, 200);
  assert.deepEqual((await before.json()).registeredPlayers, []);

  const legacyRequest = await POST(request({ action: "add", playerId: "steam_76561198847285114", displayName: "Sakura", enabled: false }));
  assert.equal(legacyRequest.status, 400);

  const response = await POST(request({ action: "add", userId: "steam_76561198847285114", displayName: "Sakura", enabled: false }));
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.registeredPlayers.length, 1);
  assert.equal(payload.registeredPlayers[0].userId, "steam_76561198847285114");
  assert.equal("id" in payload.registeredPlayers[0], false);

  const saved = JSON.parse(await readFile(join(serverDirectory, "players.json"), "utf8"));
  assert.equal(saved[0].userId, "steam_76561198847285114");
  assert.equal("id" in saved[0], false);
  assert.equal("playerId" in saved[0], false);
});

test.after(async () => {
  if (previousServerDirectory === undefined) delete process.env.PALUI_SERVER_DIR;
  else process.env.PALUI_SERVER_DIR = previousServerDirectory;
  if (previousSecret === undefined) delete process.env.AUTH_COOKIE_SECRET;
  else process.env.AUTH_COOKIE_SECRET = previousSecret;
  await rm(serverDirectory, { recursive: true, force: true });
});
