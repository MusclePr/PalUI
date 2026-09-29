import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const serverDirectory = await mkdtemp(join(tmpdir(), "palui-paused-server-"));
const previousServerDirectory = process.env.PALUI_SERVER_DIR;
process.env.PALUI_SERVER_DIR = serverDirectory;
const { isPalworldPaused, PalworldPausedError, runPalworldCommand, runPalworldRconCommand } = await import("../../lib/server/compose.ts");

test("REST stays blocked while paused and whitelist RCON resumes Pal first", async () => {
  const pausedDirectory = join(serverDirectory, "palworld");
  const pausedFile = join(pausedDirectory, ".paused");
  const commands = [];
  const execute = async (args) => {
    commands.push([...args]);
    return { stdout: "", stderr: "" };
  };

  try {
    await mkdir(pausedDirectory, { recursive: true });
    await writeFile(pausedFile, "");
    assert.equal(await isPalworldPaused(), true);

    await assert.rejects(runPalworldCommand(["rest-cli", "players"], 10_000, execute), PalworldPausedError);
    await assert.rejects(runPalworldCommand(["rcon-cli", "whitelist_get"], 10_000, execute), PalworldPausedError);
    assert.deepEqual(commands, []);

    await runPalworldCommand(["autopause", "continue"], 10_000, execute);
    assert.deepEqual(commands, [["exec", "-T", "-u", "steam", "pal", "autopause", "continue"]]);

    commands.length = 0;
    await runPalworldRconCommand(["whitelist_add steam_123"], 5_000, async (args) => {
      commands.push([...args]);
      if (args.at(-1) === "resume") await rm(pausedFile, { force: true });
      return { stdout: "", stderr: "" };
    });
    assert.deepEqual(commands, [
      ["exec", "-T", "-u", "steam", "pal", "autopause", "resume"],
      ["exec", "-T", "-u", "steam", "pal", "rcon-cli", "whitelist_add steam_123"],
    ]);

    await writeFile(pausedFile, "");
    commands.length = 0;
    await assert.rejects(runPalworldRconCommand(["whitelist_remove steam_123"], 5_000, execute), PalworldPausedError);
    assert.deepEqual(commands, [["exec", "-T", "-u", "steam", "pal", "autopause", "resume"]]);
  } finally {
    if (previousServerDirectory === undefined) delete process.env.PALUI_SERVER_DIR;
    else process.env.PALUI_SERVER_DIR = previousServerDirectory;
    await rm(serverDirectory, { recursive: true, force: true });
  }
});