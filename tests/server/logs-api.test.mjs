import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { access, chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";

const serverDirectory = await mkdtemp(join(tmpdir(), "palui-logs-api-"));
const previousServerDirectory = process.env.PALUI_SERVER_DIR;
const previousPath = process.env.PATH;
const previousSecret = process.env.AUTH_COOKIE_SECRET;
const previousContainerFlag = process.env.PALUI_LOGS_API_CONTAINER;
const secret = "logs-api-test-secret";
const logCallsPath = join(serverDirectory, "log-calls");
process.env.PALUI_SERVER_DIR = serverDirectory;
process.env.PATH = `${serverDirectory}:${previousPath ?? ""}`;
process.env.AUTH_COOKIE_SECRET = secret;
const fakeDockerPath = join(serverDirectory, "docker");
await writeFile(fakeDockerPath, `#!/bin/sh
case " $* " in
  *" ps "*) if [ "$PALUI_LOGS_API_CONTAINER" = "1" ]; then printf '{"State":"running"}\\n'; fi ;;
  *" logs "*) printf called >> "${logCallsPath}"; printf '2026-09-29T12:00:00Z api log line\\n' ;;
esac
`);
await chmod(fakeDockerPath, 0o755);

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
  const payload = Buffer.from(JSON.stringify({ role: "operator", exp: Math.floor(Date.now() / 1000) + 60 })).toString("base64url");
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  return `palui_session=${payload}.${signature}`;
}

const { GET } = await import("../../app/api/server/logs/route.ts");

test("logs API stops EventSource retries when the service container is not created", async () => {
  const response = await GET(new Request("http://palui/api/server/logs?service=pal", {
    headers: { cookie: sessionCookie() },
  }));

  assert.equal(response.status, 204);
  assert.equal(await response.text(), "");
  await assert.rejects(access(logCallsPath), { code: "ENOENT" });
});

test("logs API starts the log stream when the service container exists", async () => {
  process.env.PALUI_LOGS_API_CONTAINER = "1";
  const response = await GET(new Request("http://palui/api/server/logs?service=pal", {
    headers: { cookie: sessionCookie() },
  }));

  assert.equal(response.status, 200);
  const body = await response.text();
  assert.match(body, /event: log/);
  assert.match(body, /api log line/);
  assert.match(await readFile(logCallsPath, "utf8"), /called/);
});

test.after(async () => {
  if (previousServerDirectory === undefined) delete process.env.PALUI_SERVER_DIR;
  else process.env.PALUI_SERVER_DIR = previousServerDirectory;
  if (previousPath === undefined) delete process.env.PATH;
  else process.env.PATH = previousPath;
  if (previousSecret === undefined) delete process.env.AUTH_COOKIE_SECRET;
  else process.env.AUTH_COOKIE_SECRET = previousSecret;
  if (previousContainerFlag === undefined) delete process.env.PALUI_LOGS_API_CONTAINER;
  else process.env.PALUI_LOGS_API_CONTAINER = previousContainerFlag;
  await rm(serverDirectory, { recursive: true, force: true });
});
