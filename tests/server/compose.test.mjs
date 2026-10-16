import assert from "node:assert/strict";
import test from "node:test";
import { composeCommand, hasPalworldReadyMarker, isComposeService, palworldBackupComposeArgs, parseComposeStats, parsePalworldStatus, runComposeLifecycle, runPalworldBackupCommand } from "../../lib/server/compose.ts";

test("Compose commands use the configured project directory and file", () => {
  const command = composeCommand(["ps"]);

  assert.equal(command.command, "docker");
  assert.equal(command.args[0], "compose");
  assert.ok(command.args.includes("--project-directory"));
  assert.ok(command.args.includes("--file"));
  assert.equal(command.args.at(-1), "ps");
});

test("only Palworld and map services are accepted", () => {
  assert.equal(isComposeService("pal"), true);
  assert.equal(isComposeService("map"), true);
  assert.equal(isComposeService("proxy"), false);
  assert.equal(isComposeService("palui"), false);
  assert.equal(isComposeService(undefined), false);
});

test("Palworld status accepts supported states and numeric progress", () => {
  for (const status of ["starting", "updating", "running", "stopping", "paused", "stopped"]) {
    assert.deepEqual(parsePalworldStatus(JSON.stringify({ status, progress: 50 })), { status, progress: 50 });
  }
  assert.deepEqual(parsePalworldStatus('{"status":"running","progress":"100"}'), { status: "running", progress: 100 });
  assert.deepEqual(parsePalworldStatus('{"status":"updating","progress":42.5}'), { status: "updating", progress: 42.5 });
  assert.deepEqual(parsePalworldStatus('{"status":"starting","progress":0}'), { status: "starting", progress: 0 });
});

test("invalid Palworld status data falls back to the Docker state", () => {
  for (const contents of [
    "not json",
    '{"status":"unknown","progress":20}',
    '{"status":"running","progress":-1}',
    '{"status":"running","progress":101}',
    '{"status":"running","progress":"complete"}',
    '{"status":"running"}',
  ]) {
    assert.equal(parsePalworldStatus(contents), null);
  }
});

test("Pal readiness requires the REST API started log marker", () => {
  assert.equal(hasPalworldReadyMarker("[07:41:41][info] REST API started on port 8212"), true);
  assert.equal(hasPalworldReadyMarker("[07:41:40][info] Palworld server is starting"), false);
  assert.equal(hasPalworldReadyMarker("REST API started on port 8212"), true);
});

test("Pal backups use exec when ready or AUTO PAUSE is active, and run otherwise", async () => {
  const commands = [];
  const execute = async (args) => {
    commands.push([...args]);
    return { stdout: "", stderr: "" };
  };

  assert.deepEqual(palworldBackupComposeArgs("running", false), ["exec", "-T", "-u", "steam", "pal", "backup"]);
  assert.deepEqual(palworldBackupComposeArgs("starting", true), ["exec", "-T", "-u", "steam", "pal", "backup"]);
  assert.deepEqual(palworldBackupComposeArgs("stopped", false), ["run", "--rm", "-u", "steam", "pal", "backup"]);
  await runPalworldBackupCommand("stopped", false, execute);
  assert.deepEqual(commands, [["run", "--rm", "-u", "steam", "pal", "backup"]]);
});

test("Compose stats are parsed without inventing values", () => {
  assert.deepEqual(parseComposeStats('{"CPUPerc":"18.4%","MemUsage":"4.82GiB / 16GiB"}'), {
    cpuPercent: 18.4,
    memoryUsageBytes: 4.82 * 1024 ** 3,
    memoryLimitBytes: 16 * 1024 ** 3,
  });
  assert.deepEqual(parseComposeStats('{"CPUPerc":"n/a","MemUsage":"n/a"}'), {
    cpuPercent: null,
    memoryUsageBytes: null,
    memoryLimitBytes: null,
  });
});

test("restart explicitly runs down before up", async () => {
  const commands = [];
  await runComposeLifecycle("restart", async (args) => commands.push([...args]));

  assert.deepEqual(commands, [["down"], ["up", "-d"]]);
});

test("restart does not start the project if down fails", async () => {
  const commands = [];
  await assert.rejects(runComposeLifecycle("restart", async (args) => {
    commands.push([...args]);
    throw new Error("down failed");
  }), /down failed/);

  assert.deepEqual(commands, [["down"]]);
});

test("only one lifecycle operation per Compose project can run at a time", async () => {
  let releaseOperation;
  let signalStarted;
  const started = new Promise((resolve) => { signalStarted = resolve; });
  const firstOperation = runComposeLifecycle("stop", async () => {
    signalStarted();
    await new Promise((resolve) => { releaseOperation = resolve; });
  });

  await started;
  await assert.rejects(runComposeLifecycle("start", async () => undefined), { name: "ComposeOperationInProgressError" });
  releaseOperation();
  await firstOperation;
});