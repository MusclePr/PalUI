import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

const serverDirectory = await mkdtemp(join(tmpdir(), "palui-dashboard-cache-"));
const previousServerDirectory = process.env.PALUI_SERVER_DIR;
process.env.PALUI_SERVER_DIR = serverDirectory;
const { readDashboardCache, updateDashboardCache } = await import("../../lib/server/dashboard-cache.ts");

after(async () => {
  if (previousServerDirectory === undefined) delete process.env.PALUI_SERVER_DIR;
  else process.env.PALUI_SERVER_DIR = previousServerDirectory;
  await rm(serverDirectory, { recursive: true, force: true });
});

test("dashboard cache persists fields and partial updates preserve prior values", async () => {
  const cacheFile = join(serverDirectory, ".dashboard-cache.json");

  const initial = await updateDashboardCache({
    version: "1.2.3",
    servername: "Test World",
    description: "A cached world",
    days: 8,
  });
  assert.deepEqual({ initialVersion: initial.version, initialDays: initial.days }, { initialVersion: "1.2.3", initialDays: 8 });
  assert.equal(typeof initial.updatedAt, "string");

  const updated = await updateDashboardCache({ days: 0 });
  assert.deepEqual({
    version: updated.version,
    servername: updated.servername,
    description: updated.description,
    days: updated.days,
  }, {
    version: "1.2.3",
    servername: "Test World",
    description: "A cached world",
    days: 0,
  });
  assert.deepEqual(await readDashboardCache(), updated);
  assert.deepEqual(JSON.parse(await readFile(cacheFile, "utf8")), updated);
});

test("an unavailable or malformed cache falls back to empty values", async () => {
  await rm(join(serverDirectory, ".dashboard-cache.json"), { force: true });
  assert.equal((await readDashboardCache()).version, null);
  await writeFile(join(serverDirectory, ".dashboard-cache.json"), "not-json");
  assert.deepEqual(await readDashboardCache(), {
    version: null,
    servername: null,
    description: null,
    days: null,
    updatedAt: null,
    snapshot: null,
  });
});

test("an unavailable refresh preserves the last known dashboard snapshot", async () => {
  const lastKnownAt = "2026-10-19T00:00:00.000Z";
  const initial = await updateDashboardCache({
    snapshot: {
      container: {
        service: "pal",
        state: "running",
        name: "pal",
        image: "palworld:latest",
        startedAt: lastKnownAt,
        restartCount: 2,
        cpuPercent: 12,
        memoryUsageBytes: 120,
        memoryLimitBytes: 1200,
        statsError: null,
      },
      serverStatus: { status: "running", progress: 100 },
      paused: false,
      autoPauseEnabled: true,
      metrics: { currentplayernum: 3, maxplayernum: 32, serverfps: 60, serverfpsaverage: 59, days: 10 },
      lastRefreshAt: lastKnownAt,
      lastStatsAt: lastKnownAt,
      lastMetricsAt: lastKnownAt,
    },
  });

  const updated = await updateDashboardCache({
    snapshot: {
      container: {
        service: "pal",
        state: "unknown",
        name: null,
        image: null,
        startedAt: null,
        restartCount: null,
        cpuPercent: null,
        memoryUsageBytes: null,
        memoryLimitBytes: null,
        statsError: "Docker状態を取得できませんでした",
      },
      serverStatus: null,
      paused: false,
      autoPauseEnabled: null,
      metrics: null,
      lastRefreshAt: "2026-10-19T00:00:15.000Z",
      lastStatsAt: null,
      lastMetricsAt: null,
    },
  });

  assert.equal(updated.snapshot.container.state, "running");
  assert.equal(updated.snapshot.container.name, "pal");
  assert.equal(updated.snapshot.serverStatus.status, "running");
  assert.equal(updated.snapshot.autoPauseEnabled, true);
  assert.equal(updated.snapshot.metrics.currentplayernum, 3);
  assert.equal(updated.snapshot.lastMetricsAt, lastKnownAt);
});