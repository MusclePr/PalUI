import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const serverDirectory = await mkdtemp(join(tmpdir(), "palui-status-api-"));
process.env.PALUI_SERVER_DIR = serverDirectory;
const { isPalworldPaused, readPalworldStatus } = await import("../../lib/server/compose.ts");

test("status reader returns the shared status and detects the AUTO PAUSE marker", async (t) => {
  t.after(async () => {
    await rm(serverDirectory, { recursive: true, force: true });
    delete process.env.PALUI_SERVER_DIR;
  });

  assert.equal(await readPalworldStatus(), null);
  assert.equal(await isPalworldPaused(), false);

  const palworldDirectory = join(serverDirectory, "palworld");
  await mkdir(palworldDirectory);
  await writeFile(join(palworldDirectory, ".status"), '{"status":"updating","progress":"64"}');
  await writeFile(join(palworldDirectory, ".paused"), "");

  assert.deepEqual(await readPalworldStatus(), { status: "updating", progress: 64 });
  assert.equal(await isPalworldPaused(), true);
});