import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));

test("whitelist sync merges duplicate user IDs before using stored display names", async () => {
  const serverDirectory = await mkdtemp(join(tmpdir(), "palui-whitelist-sync-"));
  const pathDirectory = join(serverDirectory, "bin");
  const whitelistDirectory = join(serverDirectory, "palworld/Pal/Binaries/Win64/PalDefender");
  try {
    await mkdir(pathDirectory, { recursive: true });
    await mkdir(whitelistDirectory, { recursive: true });
    await copyFile(join(repositoryRoot, "palui/template/whitelist.sh"), join(serverDirectory, "whitelist.sh"));
    await writeFile(join(serverDirectory, ".env"), "STEAM_WEBAPIKEY=test\n");
    await writeFile(join(serverDirectory, "palworld/Pal/Binaries/Win64/PalDefender/WhiteList.json"), JSON.stringify(["steam_123"]));
    await writeFile(join(serverDirectory, "players.json"), JSON.stringify([
      { userId: "steam_123", displayName: "まっする\nまっする", role: "メンバー", white: false, banned: false, level: 3, firstLogin: "2025-02-01T00:00:00.000Z", lastLogin: "2025-02-02T00:00:00.000Z" },
      { userId: "steam_123", displayName: "まっする", role: "管理者", white: false, banned: true, level: 12, firstLogin: "2025-01-01T00:00:00.000Z", lastLogin: "2025-03-01T00:00:00.000Z" },
    ]));
    const dockerStub = join(pathDirectory, "docker");
    await writeFile(dockerStub, "#!/bin/sh\nexit 0\n");
    await chmod(dockerStub, 0o755);

    await execFileAsync("bash", ["./whitelist.sh"], {
      cwd: serverDirectory,
      env: { ...process.env, MODE: "json", PATH: `${pathDirectory}:${process.env.PATH}` },
    });

    const saved = JSON.parse(await readFile(join(serverDirectory, "players.json"), "utf8"));
    assert.equal(saved.length, 1);
    assert.deepEqual(saved[0], {
      userId: "steam_123",
      displayName: "まっする",
      role: "管理者",
      white: true,
      banned: true,
      level: 12,
      firstLogin: "2025-01-01T00:00:00.000Z",
      lastLogin: "2025-03-01T00:00:00.000Z",
    });
  } finally {
    await rm(serverDirectory, { recursive: true, force: true });
  }
});