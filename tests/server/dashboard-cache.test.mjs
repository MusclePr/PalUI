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
  });
});