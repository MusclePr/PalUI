import assert from "node:assert/strict";
import test from "node:test";
import { composeCommand, hasPalworldReadyMarker, isComposeService, parseComposeStats, runComposeLifecycle } from "../../lib/server/compose.ts";

test("Compose commands use the configured project directory and file", () => {
  const command = composeCommand(["ps"]);

  assert.equal(command.command, "docker");
  assert.equal(command.args[0], "compose");
  assert.ok(command.args.includes("--project-directory"));
  assert.ok(command.args.includes("--file"));
  assert.equal(command.args.at(-1), "ps");
});

test("only the three managed services are accepted", () => {
  assert.equal(isComposeService("pal"), true);
  assert.equal(isComposeService("proxy"), true);
  assert.equal(isComposeService("map"), true);
  assert.equal(isComposeService("palui"), false);
  assert.equal(isComposeService(undefined), false);
});

test("Pal readiness requires the REST API started log marker", () => {
  assert.equal(hasPalworldReadyMarker("[07:41:41][info] REST API started on port 8212"), true);
  assert.equal(hasPalworldReadyMarker("[07:41:40][info] Palworld server is starting"), false);
  assert.equal(hasPalworldReadyMarker("REST API started on port 8212"), true);
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