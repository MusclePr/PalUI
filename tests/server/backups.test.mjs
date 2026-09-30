import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import * as tar from "tar";
import ts from "typescript";

const serverDirectory = await mkdtemp(join(tmpdir(), "palui-backups-api-"));
const previousServerDirectory = process.env.PALUI_SERVER_DIR;
const previousSecret = process.env.AUTH_COOKIE_SECRET;
const previousPath = process.env.PATH;
const previousUpFail = process.env.PALUI_TEST_DOCKER_UP_FAIL;
process.env.PALUI_SERVER_DIR = serverDirectory;
process.env.AUTH_COOKIE_SECRET = "backups-api-test-secret";
process.env.PALUI_TEST_DOCKER_LOG = join(serverDirectory, "docker-commands.log");
process.env.PALUI_TEST_DOCKER_DOWN_FILE = join(serverDirectory, "docker-is-down");
process.env.PALUI_TEST_DOCKER_MODE = "stopped";
process.env.PALUI_TEST_DOCKER_UP_FAIL = "0";
const fakeDockerDirectory = join(serverDirectory, "bin");
await mkdir(fakeDockerDirectory, { recursive: true });
const fakeDockerPath = join(fakeDockerDirectory, "docker");
await writeFile(fakeDockerPath, `#!/bin/sh
printf '%s\\n' "$*" >> "$PALUI_TEST_DOCKER_LOG"
case "$*" in
  *" down"*) touch "$PALUI_TEST_DOCKER_DOWN_FILE"; printf '%s\n' 'Container pal Stopped' ;;
  *" up -d"*) rm -f "$PALUI_TEST_DOCKER_DOWN_FILE"; printf '%s\n' 'Container pal Started'; if [ "$PALUI_TEST_DOCKER_UP_FAIL" = "1" ]; then printf '%s\n' 'network warning from fake compose' >&2; exit 1; fi ;;
  *"ps --all"*)
    if [ ! -f "$PALUI_TEST_DOCKER_DOWN_FILE" ] && { [ "$PALUI_TEST_DOCKER_MODE" = "ready" ] || [ "$PALUI_TEST_DOCKER_MODE" = "auto-paused" ] || [ "$PALUI_TEST_DOCKER_MODE" = "partial-start" ]; }; then
      printf '%s\\n' '{"ID":"test-id","Name":"pal-test","State":"running","Image":"pal-test"}'
    fi
    ;;
  *"inspect"*) printf '%s\\n' '[{"State":{"StartedAt":"2026-09-30T00:00:00Z"},"Config":{"Image":"pal-test"},"RestartCount":0}]' ;;
  *"logs"*) printf '%s\\n' 'REST API started on port 8212' ;;
  *"stats"*) printf '%s\\n' '{"CPUPerc":"0.0%","MemUsage":"1GiB / 2GiB"}' ;;
esac
`);
await chmod(fakeDockerPath, 0o755);
process.env.PATH = `${fakeDockerDirectory}:${previousPath ?? ""}`;
await mkdir(join(serverDirectory, "palworld", "backups"), { recursive: true });
await writeFile(join(serverDirectory, ".env"), `PUID=${process.getuid()}\nPGID=${process.getgid()}\n`);

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
  const signature = createHmac("sha256", process.env.AUTH_COOKIE_SECRET).update(payload).digest("base64url");
  return `palui_session=${payload}.${signature}`;
}

function request(role, method = "GET", body, origin = "http://palui") {
  return new Request("http://palui/api/backups", {
    method,
    headers: {
      ...(role ? { cookie: sessionCookie(role) } : {}),
      ...(method === "POST" ? { "content-type": "application/json", host: "palui", ...(origin ? { origin } : {}) } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function waitForRestoreOperation(operationId) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const response = await GET(new Request(`http://palui/api/backups?operationId=${operationId}`, {
      headers: { cookie: sessionCookie("operator") },
    }));
    assert.equal(response.status, 200);
    const operation = await response.json();
    if (operation.status !== "running") return operation;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("restore operation did not finish");
}

const { GET, POST } = await import("../../app/api/backups/route.ts");

test("backup API requires an authenticated session", async () => {
  assert.equal((await GET(request(null))).status, 401);
  assert.equal((await POST(request(null, "POST", { action: "create" }))).status, 401);
});

test("backup API rejects cross-origin and restore requests without stop confirmation", async () => {
  assert.equal((await POST(request("operator", "POST", { action: "create" }, "https://attacker.example"))).status, 403);
  assert.equal((await POST(request("operator", "POST", {
    action: "restore",
    name: "world.tar.gz",
    stopConfirmed: false,
    startAfterRestore: false,
  }))).status, 400);
});

test("backup API returns an empty real list rather than fixtures", async () => {
  const response = await GET(request("operator"));
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.deepEqual(data.backups, []);
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("backup creation uses run while stopped and never issues a separate save", async () => {
  const { createBackup } = await import("../../lib/server/palworld.ts");
  await rm(process.env.PALUI_TEST_DOCKER_LOG, { force: true });
  process.env.PALUI_TEST_DOCKER_MODE = "stopped";

  await createBackup();

  const commands = await readFile(process.env.PALUI_TEST_DOCKER_LOG, "utf8");
  assert.match(commands, /run --rm -u steam pal backup/);
  assert.doesNotMatch(commands, /rest-cli save|autopause resume/);
});

test("backup creation uses exec while ready or AUTO PAUSE is active", async () => {
  const { createBackup } = await import("../../lib/server/palworld.ts");
  for (const mode of ["ready", "auto-paused"]) {
    await rm(process.env.PALUI_TEST_DOCKER_LOG, { force: true });
    process.env.PALUI_TEST_DOCKER_MODE = mode;
    if (mode === "auto-paused") await writeFile(join(serverDirectory, "palworld", ".paused"), "");

    await createBackup();

    const commands = await readFile(process.env.PALUI_TEST_DOCKER_LOG, "utf8");
    assert.match(commands, /exec -T -u steam pal backup/);
    assert.doesNotMatch(commands, /rest-cli save|autopause resume/);
    if (mode === "auto-paused") await rm(join(serverDirectory, "palworld", ".paused"), { force: true });
  }
});

test("restore replaces Saved, preserves nested backup directories, and honors the start choice", async () => {
  const { listBackups, restoreBackup } = await import("../../lib/server/palworld.ts");
  const archiveSource = join(serverDirectory, "archive-source");
  const archivePath = join(serverDirectory, "palworld", "backups", "valid.tar.gz");
  const savedDirectory = join(serverDirectory, "palworld", "Pal", "Saved");
  await mkdir(join(archiveSource, "Saved", "World"), { recursive: true });
  await writeFile(join(archiveSource, "Saved", "World", "new.sav"), "new-world");
  await tar.c({ file: archivePath, cwd: archiveSource, gzip: true }, ["Saved"]);
  const backup = (await listBackups()).find((entry) => entry.name === "valid.tar.gz");
  assert.ok(backup);
  assert.equal(backup.size, `${(backup.sizeBytes / (1024 ** 2)).toFixed(2)} MiB`);
  await mkdir(join(savedDirectory, "backup"), { recursive: true });
  await writeFile(join(savedDirectory, "old.sav"), "old-world");
  await writeFile(join(savedDirectory, "backup", "metadata.sav"), "preserve");
  await rm(process.env.PALUI_TEST_DOCKER_LOG, { force: true });

  const response = await POST(request("operator", "POST", { action: "restore", name: "valid.tar.gz", stopConfirmed: true, startAfterRestore: false }));
  assert.equal(response.status, 202);
  const { operationId } = await response.json();
  const operation = await waitForRestoreOperation(operationId);
  assert.equal(operation.status, "completed");
  assert.match(operation.logs.join("\n"), /Container pal Stopped/);
  const result = operation.result;
  assert.equal(result.restored, true);
  assert.equal(result.started, false);
  assert.equal(await readFile(join(savedDirectory, "World", "new.sav"), "utf8"), "new-world");
  assert.equal(await readFile(join(savedDirectory, "backup", "metadata.sav"), "utf8"), "preserve");
  await assert.rejects(readFile(join(savedDirectory, "old.sav")), { code: "ENOENT" });
  assert.match(await readFile(process.env.PALUI_TEST_DOCKER_LOG, "utf8"), /down/);

  const startedResult = await restoreBackup("valid.tar.gz", true);
  assert.equal(startedResult.started, true);
  assert.match(await readFile(process.env.PALUI_TEST_DOCKER_LOG, "utf8"), /up -d/);
});

test("restore operation logs Compose output and reports partial startup errors", async () => {
  process.env.PALUI_TEST_DOCKER_MODE = "partial-start";
  process.env.PALUI_TEST_DOCKER_UP_FAIL = "1";

  const response = await POST(request("operator", "POST", { action: "restore", name: "valid.tar.gz", stopConfirmed: true, startAfterRestore: true }));
  assert.equal(response.status, 202);
  const { operationId } = await response.json();
  const operation = await waitForRestoreOperation(operationId);

  assert.equal(operation.status, "warning");
  assert.equal(operation.result.started, true);
  assert.match(operation.logs.join("\n"), /Container pal Stopped/);
  assert.match(operation.logs.join("\n"), /Container pal Started/);
  assert.match(operation.logs.join("\n"), /REST API started on port 8212/);
  assert.match(operation.logs.join("\n"), /network warning from fake compose/);
  assert.match(operation.logs.join("\n"), /Palworldコンテナは起動しています/);
  process.env.PALUI_TEST_DOCKER_MODE = "stopped";
  process.env.PALUI_TEST_DOCKER_UP_FAIL = "0";
});

test("restore rejects a PALUI and Palworld UID mismatch before stopping Compose", async () => {
  const { restoreBackup } = await import("../../lib/server/palworld.ts");
  await writeFile(join(serverDirectory, ".env"), `PUID=${process.getuid() + 1}\nPGID=${process.getgid()}\n`);
  await rm(process.env.PALUI_TEST_DOCKER_LOG, { force: true });

  await assert.rejects(restoreBackup("valid.tar.gz"), { status: 409 });
  await assert.rejects(readFile(process.env.PALUI_TEST_DOCKER_LOG), { code: "ENOENT" });
  assert.equal(await readFile(join(serverDirectory, "palworld", "Pal", "Saved", "World", "new.sav"), "utf8"), "new-world");
  await writeFile(join(serverDirectory, ".env"), `PUID=${process.getuid()}\nPGID=${process.getgid()}\n`);
});

test("restore rejects symlinks before stopping the Compose project", async () => {
  const { listBackups, restoreBackup } = await import("../../lib/server/palworld.ts");
  const unsafeSource = join(serverDirectory, "unsafe-source");
  const unsafeArchive = join(serverDirectory, "palworld", "backups", "unsafe.tar.gz");
  await mkdir(join(unsafeSource, "Saved"), { recursive: true });
  await symlink("../../outside", join(unsafeSource, "Saved", "link"));
  await tar.c({ file: unsafeArchive, cwd: unsafeSource, gzip: true }, ["Saved"]);
  await rm(process.env.PALUI_TEST_DOCKER_LOG, { force: true });

  assert.equal((await listBackups()).find((backup) => backup.name === "unsafe.tar.gz")?.integrity, "破損");
  await assert.rejects(restoreBackup("unsafe.tar.gz"), { status: 422 });
  await assert.rejects(readFile(process.env.PALUI_TEST_DOCKER_LOG), { code: "ENOENT" });
  assert.equal(await readFile(join(serverDirectory, "palworld", "Pal", "Saved", "World", "new.sav"), "utf8"), "new-world");
});

test.after(async () => {
  if (previousServerDirectory === undefined) delete process.env.PALUI_SERVER_DIR;
  else process.env.PALUI_SERVER_DIR = previousServerDirectory;
  if (previousSecret === undefined) delete process.env.AUTH_COOKIE_SECRET;
  else process.env.AUTH_COOKIE_SECRET = previousSecret;
  if (previousPath === undefined) delete process.env.PATH;
  else process.env.PATH = previousPath;
  if (previousUpFail === undefined) delete process.env.PALUI_TEST_DOCKER_UP_FAIL;
  else process.env.PALUI_TEST_DOCKER_UP_FAIL = previousUpFail;
  await rm(serverDirectory, { recursive: true, force: true });
});