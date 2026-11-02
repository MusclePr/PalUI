import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";
import ts from "typescript";

const serverDirectory = await mkdtemp(join(tmpdir(), "palui-overview-api-"));
const previousServerDirectory = process.env.PALUI_SERVER_DIR;
const previousPath = process.env.PATH;
const previousSecret = process.env.AUTH_COOKIE_SECRET;
const previousOverviewState = process.env.PALUI_OVERVIEW_API_STATE;
const secret = "overview-api-test-secret";
const markerFile = join(serverDirectory, "palworld", ".autopause-disabled");
const overrideFile = join(serverDirectory, "override.env");
process.env.PALUI_SERVER_DIR = serverDirectory;
process.env.PATH = `${serverDirectory}:${previousPath ?? ""}`;
process.env.AUTH_COOKIE_SECRET = secret;

await mkdir(join(serverDirectory, "defaults"), { recursive: true });
await mkdir(join(serverDirectory, "palworld"), { recursive: true });
await Promise.all([
  writeFile(join(serverDirectory, "defaults/system.env"), "#|AUTO_PAUSE_ENABLED|BOOL|AUTO PAUSE\nAUTO_PAUSE_ENABLED=true\n"),
  writeFile(overrideFile, "# AUTO PAUSE must remain a persistent setting\nAUTO_PAUSE_ENABLED=true\n"),
  writeFile(join(serverDirectory, "docker"), `#!/bin/sh
case " $* " in
  *" ps --all --format json pal "*)
    if [ "$PALUI_OVERVIEW_API_STATE" = "unknown" ]; then
      printf '{"State":"mystery","ID":"overview-test-container","Name":"pal"}\\n'
    else
      printf '{"State":"running","ID":"overview-test-container","Name":"pal"}\\n'
    fi
    ;;
  *" inspect overview-test-container "*)
    printf '[{"State":{"StartedAt":"2026-01-01T00:00:00Z"},"Config":{"Image":"pal"},"RestartCount":0}]\\n'
    ;;
  *" logs "*)
    printf 'REST API started on port 8212\\n'
    ;;
  *" stats "*)
    printf '{"CPUPerc":"0.5%","MemUsage":"1MiB / 2MiB"}\\n'
    ;;
  *" autopause stop "*)
    touch "${markerFile}"
    ;;
  *" autopause continue "*)
    rm -f "${markerFile}"
    ;;
esac
`),
]);
await chmod(join(serverDirectory, "docker"), 0o755);

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

function sessionCookie(role = "operator") {
  const payload = Buffer.from(JSON.stringify({ role, exp: Math.floor(Date.now() / 1000) + 60 })).toString("base64url");
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  return `palui_session=${payload}.${signature}`;
}

function getRequest() {
  return new Request("http://palui/api/server/overview", {
    headers: { cookie: sessionCookie() },
  });
}

function postRequest(enabled) {
  return new Request("http://palui/api/server/overview", {
    method: "POST",
    headers: {
      cookie: sessionCookie(),
      "content-type": "application/json",
      host: "palui",
      origin: "http://palui",
    },
    body: JSON.stringify({ autoPauseEnabled: enabled }),
  });
}

const { GET, POST } = await import("../../app/api/server/overview/route.ts");

test("overview reflects temporary force-disabled state without changing the saved setting", async () => {
  const savedOverride = await readFile(overrideFile, "utf8");

  const initiallyEnabled = await GET(getRequest());
  assert.equal(initiallyEnabled.status, 200);
  assert.equal((await initiallyEnabled.json()).autoPauseEnabled, true);

  const disabled = await POST(postRequest(false));
  assert.equal(disabled.status, 200);
  assert.deepEqual(await disabled.json(), { enabled: false });
  assert.equal(await readFile(markerFile, "utf8"), "");

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const refreshed = await GET(getRequest());
    assert.equal(refreshed.status, 200);
    assert.equal((await refreshed.json()).autoPauseEnabled, false);
  }

  process.env.PALUI_OVERVIEW_API_STATE = "unknown";
  const unavailable = await GET(getRequest());
  const unavailableOverview = await unavailable.json();
  assert.equal(unavailableOverview.autoPauseEnabled, false);
  assert.equal(typeof unavailableOverview.errors.autoPause, "string");
  if (previousOverviewState === undefined) delete process.env.PALUI_OVERVIEW_API_STATE;
  else process.env.PALUI_OVERVIEW_API_STATE = previousOverviewState;

  const enabled = await POST(postRequest(true));
  assert.equal(enabled.status, 200);
  assert.deepEqual(await enabled.json(), { enabled: true });
  assert.equal((await GET(getRequest()).then((response) => response.json())).autoPauseEnabled, true);

  await rm(markerFile, { force: true });
  assert.equal((await GET(getRequest()).then((response) => response.json())).autoPauseEnabled, true);
  assert.equal(await readFile(overrideFile, "utf8"), savedOverride);
});

test("overview keeps AUTO PAUSE off when its saved setting is disabled", async () => {
  const savedOverride = await readFile(overrideFile, "utf8");
  await writeFile(overrideFile, "AUTO_PAUSE_ENABLED=false\n");

  try {
    const response = await GET(getRequest());
    assert.equal((await response.json()).autoPauseEnabled, false);

    const enable = await POST(postRequest(true));
    assert.equal(enable.status, 503);
    assert.equal((await enable.json()).error, "AUTO PAUSE機能を変更できませんでした");
    assert.equal(existsSync(markerFile), false);
  } finally {
    await writeFile(overrideFile, savedOverride);
  }
});

after(async () => {
  if (previousServerDirectory === undefined) delete process.env.PALUI_SERVER_DIR;
  else process.env.PALUI_SERVER_DIR = previousServerDirectory;
  if (previousPath === undefined) delete process.env.PATH;
  else process.env.PATH = previousPath;
  if (previousSecret === undefined) delete process.env.AUTH_COOKIE_SECRET;
  else process.env.AUTH_COOKIE_SECRET = previousSecret;
  if (previousOverviewState === undefined) delete process.env.PALUI_OVERVIEW_API_STATE;
  else process.env.PALUI_OVERVIEW_API_STATE = previousOverviewState;
  await rm(serverDirectory, { recursive: true, force: true });
});
