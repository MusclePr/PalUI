import { cp, lstat, mkdir, open, readFile, readdir, rename, rm, stat, statfs, unlink, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parse as parseDotenv } from "dotenv";
import * as tar from "tar";
import { isPalworldPaused, PalworldPausedError, readComposeServiceSnapshot, resumePalworldIfPaused, runCompose, runPalworldBackupCommand, runPalworldCommand, runPalworldRconCommand, withComposeOperation } from "./compose";

const execFileAsync = promisify(execFile);
const whitelistFile = "/server/palworld/Pal/Binaries/Win64/PalDefender/WhiteList.json";
const settingsRoot = process.env.PALUI_SERVER_DIR ?? (existsSync("/server") ? "/server" : `${process.cwd()}/palui/server`);
const palworldDirectory = `${settingsRoot}/palworld`;
const backupDirectory = `${palworldDirectory}/backups`;
const registeredPlayersFile = `${settingsRoot}/players.json`;
const settingsFiles = {
  compose: { defaults: "defaults/compose.env", target: ".env" },
  system: { defaults: "defaults/system.env", target: "override.env" },
  server: { defaults: "defaults/game_server.env", target: "override.env" },
  features: { defaults: "defaults/game_features.env", target: "override.env" },
  balance: { defaults: "defaults/game_balance.env", target: "override.env" },
  performance: { defaults: "defaults/game_performance.env", target: "override.env" },
} as const;
const settingsTargets = [".env", "override.env"] as const;

export type PalworldInfo = {
  version: string;
  servername: string;
  description: string;
  worldguid: string;
};

export type PalworldMetrics = {
  currentplayernum: number;
  serverfps: number;
  serverfpsaverage: number;
  serverframetime: number;
  days: number;
  maxplayernum: number;
  basecampnum: number;
  uptime: number;
};

export type PalworldPlayer = {
  name: string;
  playerId: string;
  userId: string;
  ip: string;
  ping: number;
  buildingCount: number;
  level: number;
  lastLogin: string | null;
  banned: boolean;
};

export type RegisteredPlayer = {
  id: string;
  displayName: string;
  role: string;
  white: boolean;
  banned: boolean;
  level: number;
  lastLogin: string | null;
  firstLogin: string | null;
};

export type DetectedPlayer = {
  id: string;
  displayName: string;
  lastLogin: string | null;
};

export type DetectedRegistrationResult = {
  playerId: string;
  ok: boolean;
  reason?: string;
};

// whitelist.sh の IsVaridID / IsValidName と同じ規則
export const detectedIdPattern = /^[a-z0-9]+_[0-9]+$/;
export const forbiddenNameChars = /["'\\`$&|;<>]/;

export type AddRegisteredPlayerInput = {
  playerId: string;
  displayName: string;
  enabled: boolean;
  role?: string;
};

export class PlayerStoreError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

export class BackupError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

type CachedPlayers = { players: PalworldPlayer[]; updatedAt: string };
let onlinePlayersCache: CachedPlayers | null = null;

async function execPalworldCli(command: "info" | "metrics") {
  // コマンド名と引数は固定し、利用者入力を Docker exec の引数へ渡さない。
  const result = await runPalworldCommand(["rest-cli", command]);
  return JSON.parse(result.stdout) as unknown;
}

async function execPlayers() {
  const result = await runPalworldCommand(["rest-cli", "players"]);
  return JSON.parse(result.stdout) as unknown;
}

async function execContainerCommand(command: "save" | "backup" | "restore", argument?: string) {
  // バックアップ操作もコマンドと引数を固定し、ファイル名をシェル文字列へ連結しない。
  const args: string[] = [command];
  if (argument) args.push(argument);
  return runPalworldCommand(args, 60_000);
}

function normalizePlayers(value: unknown): PalworldPlayer[] {
  const source = Array.isArray(value) ? value : (value as { players?: unknown[] } | null)?.players;
  if (!Array.isArray(source)) return [];
  return source.map((player) => {
    const item = player as Record<string, unknown>;
    return {
      name: String(item.name ?? item.accountName ?? "Unknown player"),
      playerId: String(item.playerId ?? item.player_id ?? ""),
      userId: String(item.userId ?? item.user_id ?? ""),
      ip: String(item.ip ?? ""),
      ping: Number(item.ping ?? 0),
      buildingCount: Number(item.buildingCount ?? item.building_count ?? 0),
      level: Number(item.level ?? 0),
      lastLogin: typeof (item.lastLogin ?? item.last_login) === "string" ? String(item.lastLogin ?? item.last_login) : null,
      banned: item.banned === true,
    };
  }).filter((player) => player.playerId.length > 0);
}

function assertPlayerId(playerId: string) {
  if (!/^[-_a-zA-Z0-9:.]+$/.test(playerId)) throw new PlayerStoreError("不正なプレイヤー ID です", 400);
}

function normalizeRegisteredPlayers(value: unknown): RegisteredPlayer[] {
  if (!Array.isArray(value)) return [];
  return value.map((player) => {
    const item = player as Record<string, unknown>;
    const id = String(item.id ?? item.playerId ?? "").trim();
    return {
      id,
      displayName: String(item.displayName ?? item.name ?? "").trim(),
      role: String(item.role ?? "メンバー").trim() || "メンバー",
      white: item.white === true,
      banned: item.banned === true,
      level: Number.isFinite(Number(item.level)) ? Number(item.level) : 1,
      lastLogin: typeof item.lastLogin === "string" ? item.lastLogin : null,
      firstLogin: typeof item.firstLogin === "string" ? item.firstLogin : null,
    };
  }).filter((player) => player.id.length > 0);
}

async function readRegisteredPlayers() {
  try {
    return normalizeRegisteredPlayers(JSON.parse(await readFile(registeredPlayersFile, "utf8")) as unknown);
  } catch {
    return [];
  }
}

async function writeRegisteredPlayers(players: RegisteredPlayer[]) {
  const temporaryFile = `${registeredPlayersFile}.tmp-${process.pid}`;
  await mkdir(settingsRoot, { recursive: true });
  await writeFile(temporaryFile, `${JSON.stringify(players, null, 2)}\n`, "utf8");
  await rename(temporaryFile, registeredPlayersFile);
}

async function readWhitelist(): Promise<string[]> {
  try {
    const value = JSON.parse(await readFile(whitelistFile, "utf8")) as unknown;
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

async function writeWhitelist(playerIds: string[]) {
  const temporaryFile = `${whitelistFile}.tmp-${process.pid}`;
  await mkdir(whitelistFile.slice(0, whitelistFile.lastIndexOf("/")), { recursive: true });
  await writeFile(temporaryFile, `${JSON.stringify([...new Set(playerIds)], null, 4)}\n`, "utf8");
  await rename(temporaryFile, whitelistFile);
}

async function execWhitelist(command: "whitelist_add" | "whitelist_remove", playerId: string) {
  await runPalworldRconCommand([`${command} ${playerId}`], 5_000);
}

async function updateRegisteredPlayerWhite(playerId: string, enabled: boolean) {
  const players = await readRegisteredPlayers();
  if (!players.some((player) => player.id === playerId)) return;
  await writeRegisteredPlayers(players.map((player) => player.id === playerId ? { ...player, white: enabled } : player));
}

export async function readPlayers() {
  let paused = await isPalworldPaused();
  const whitelist = await readWhitelist();
  const registeredPlayers = await readRegisteredPlayers();
  let onlinePlayers = onlinePlayersCache?.players ?? [];
  let source: "rest-cli" | "cache" | "players.json" = onlinePlayersCache ? "cache" : "players.json";
  if (!paused) {
    try {
      onlinePlayers = normalizePlayers(await execPlayers());
      onlinePlayersCache = { players: onlinePlayers, updatedAt: new Date().toISOString() };
      source = "rest-cli";
    } catch (error) {
      if (error instanceof PalworldPausedError) paused = true;
      // サーバー停止中も、最後に取得したオンライン情報をオフライン履歴として表示する。
    }
  }
  return { onlinePlayers, registeredPlayers, whitelist, cachedAt: onlinePlayersCache?.updatedAt ?? null, paused, source };
}

export async function updateWhitelist(playerId: string, enabled: boolean) {
  assertPlayerId(playerId);
  try {
    await resumePalworldIfPaused();
  } catch {
    throw new PlayerStoreError("AUTO PAUSEから復帰できないためRCONを実行できません", 503);
  }
  const whitelist = await readWhitelist();
  const next = enabled ? [...whitelist, playerId] : whitelist.filter((id) => id !== playerId);
  await updateRegisteredPlayerWhite(playerId, enabled);
  try {
    await execWhitelist(enabled ? "whitelist_add" : "whitelist_remove", playerId);
  } catch (error) {
    if (error instanceof PalworldPausedError) throw new PlayerStoreError(error.message, 409);
    if (await isPalworldPaused()) throw new PlayerStoreError("AUTO PAUSEから復帰できなかったためRCONを実行できません", 503);
    // RCON を受け付けない状態では、仕様で定めたファイルを直接更新する。
    try { await writeWhitelist(next); } catch { return { playerId, enabled, whitelist: next }; }
  }
  return { playerId, enabled, whitelist: await readWhitelist() };
}

async function execWhitelistScript(args: string[]) {
  if (args[0] === "add" || args[0] === "remove") {
    try {
      await resumePalworldIfPaused();
    } catch {
      throw new PlayerStoreError("AUTO PAUSEから復帰できないためRCONを実行できません", 503);
    }
  }
  return execFileAsync("bash", ["./whitelist.sh", ...args], {
    cwd: settingsRoot,
    env: { ...process.env, MODE: "json" },
    timeout: 60_000,
    maxBuffer: 256 * 1024,
  });
}

export async function detectUnregisteredPlayers(): Promise<DetectedPlayer[]> {
  let stdout: string;
  try {
    stdout = (await execWhitelistScript([])).stdout.trim();
  } catch {
    throw new PlayerStoreError("whitelist.sh を実行できませんでした", 503);
  }
  if (!stdout) return [];
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw new PlayerStoreError("未登録プレイヤー情報を解析できませんでした", 502);
  }
  if (!Array.isArray(value)) throw new PlayerStoreError("未登録プレイヤー情報を解析できませんでした", 502);
  return value.flatMap((entry) => {
    const item = entry as Record<string, unknown>;
    const id = String(item.id ?? "").trim();
    if (!/^[-_a-zA-Z0-9:.]+$/.test(id) || item.white === true) return [];
    return [{
      id,
      displayName: String(item.displayName ?? "").trim(),
      lastLogin: typeof item.lastLogin === "string" && item.lastLogin ? item.lastLogin : null,
    }];
  });
}

function sanitizeDetectedName(name: string, playerId: string) {
  // eslint-disable-next-line no-control-regex
  const cleaned = name.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 64);
  return cleaned || playerId;
}

export async function registerDetectedPlayers(entries: { playerId: string; displayName: string }[]) {
  const results: DetectedRegistrationResult[] = [];
  // players.json への書き込み競合を避けるため逐次実行する
  for (const entry of entries) {
    const playerId = entry.playerId.trim();
    const displayName = sanitizeDetectedName(entry.displayName, playerId);
    if (!detectedIdPattern.test(playerId)) {
      results.push({ playerId, ok: false, reason: "invalid ID" });
      continue;
    }
    if (forbiddenNameChars.test(displayName)) {
      results.push({ playerId, ok: false, reason: "invalid name" });
      continue;
    }
    try {
      await execWhitelistScript(["add", playerId, displayName]);
      results.push({ playerId, ok: true });
    } catch (error) {
      const stderr = (error as { stderr?: unknown }).stderr;
      results.push({ playerId, ok: false, reason: typeof stderr === "string" && stderr.trim() ? stderr.trim().split("\n").pop() : "whitelist.sh add failed" });
    }
  }
  return { ...(await readPlayers()), results };
}

export async function addRegisteredPlayer(input: AddRegisteredPlayerInput) {
  const playerId = input.playerId.trim();
  const displayName = input.displayName.trim();
  assertPlayerId(playerId);
  if (!displayName) throw new PlayerStoreError("プレイヤー名を入力してください", 400);
  if (input.enabled) {
    try {
      await resumePalworldIfPaused();
    } catch {
      throw new PlayerStoreError("AUTO PAUSEから復帰できないためRCONを実行できません", 503);
    }
  }
  const players = await readRegisteredPlayers();
  if (players.some((player) => player.id === playerId)) throw new PlayerStoreError("このプレイヤーは既に登録されています", 409);
  const timestamp = new Date().toISOString();
  const nextPlayers = [...players, {
    id: playerId,
    displayName,
    role: input.role?.trim() || "メンバー",
    white: input.enabled,
    banned: false,
    level: 1,
    lastLogin: timestamp,
    firstLogin: timestamp,
  }];
  await writeRegisteredPlayers(nextPlayers);
  if (input.enabled) await updateWhitelist(playerId, true);
  return await readPlayers();
}

export async function deleteRegisteredPlayer(playerId: string) {
  const normalizedPlayerId = playerId.trim();
  assertPlayerId(normalizedPlayerId);
  try {
    await resumePalworldIfPaused();
  } catch {
    throw new PlayerStoreError("AUTO PAUSEから復帰できないためRCONを実行できません", 503);
  }
  const players = await readRegisteredPlayers();
  if (!players.some((player) => player.id === normalizedPlayerId)) throw new PlayerStoreError("登録済みプレイヤーが見つかりません", 404);
  await writeRegisteredPlayers(players.filter((player) => player.id !== normalizedPlayerId));
  await updateWhitelist(normalizedPlayerId, false);
  return await readPlayers();
}

export async function listBackups() {
  try {
    const entries = await readdir(backupDirectory, { withFileTypes: true });
    const backups = await Promise.all(entries.filter((entry) => entry.isFile() && entry.name.endsWith(".tar.gz")).map(async (entry) => {
      const archivePath = join(backupDirectory, entry.name);
      const file = await lstat(archivePath);
      const integrity = file.isFile() && await isValidBackupArchive(archivePath) ? "検証済み" as const : "破損" as const;
      return { name: entry.name, createdAt: file.mtime.toISOString(), size: `${(file.size / (1024 ** 2)).toFixed(2)} MiB`, sizeBytes: file.size, integrity, source: "server" as const };
    }));
    return backups.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  } catch {
    return [];
  }
}

export async function readStorageUsage() {
  try {
    const filesystem = await statfs(palworldDirectory);
    const totalBytes = Number(filesystem.blocks) * Number(filesystem.bsize);
    const freeBytes = Number(filesystem.bavail) * Number(filesystem.bsize);
    const backups = await listBackups();
    const backupBytes = backups.reduce((total, backup) => total + backup.sizeBytes, 0);
    return {
      totalBytes,
      freeBytes,
      backupBytes,
      systemBytes: Math.max(totalBytes - freeBytes - backupBytes, 0),
      source: "server" as const,
    };
  } catch {
    return {
      totalBytes: 0,
      freeBytes: 0,
      backupBytes: 0,
      systemBytes: 0,
      source: "unavailable" as const,
    };
  }
}

export async function savePalworldWorld() {
  await execContainerCommand("save");
  return { saved: true };
}

export async function createBackup() {
  return withComposeOperation(async () => {
    const [snapshot, autoPaused] = await Promise.all([readComposeServiceSnapshot("pal"), isPalworldPaused()]);
    await runPalworldBackupCommand(snapshot.state, autoPaused);
    return { created: true, backups: await listBackups() };
  });
}

function validateBackupEntry(entryPath: string, entryType: string) {
  const normalizedPath = posix.normalize(entryPath.replace(/\/$/, ""));
  if (entryPath.includes("\\") || posix.isAbsolute(entryPath) || entryPath.split("/").includes("..") || normalizedPath === ".." || normalizedPath.startsWith("../")) {
    throw new Error("バックアップに安全でないパスが含まれています");
  }
  if (normalizedPath !== "Saved" && !normalizedPath.startsWith("Saved/")) {
    throw new Error("バックアップにSaved以外のデータが含まれています");
  }
  if (entryType !== "File" && entryType !== "Directory") {
    throw new Error("リンクまたは特殊ファイルを含むバックアップは復元できません");
  }
  if (normalizedPath === "Saved" && entryType !== "Directory") {
    throw new Error("バックアップのSavedディレクトリが不正です");
  }
}

async function inspectBackupArchive(archivePath: string) {
  let savedFileCount = 0;
  let validationError: Error | null = null;
  await tar.t({
    file: archivePath,
    strict: true,
    onReadEntry(entry) {
      try {
        validateBackupEntry(entry.path, entry.type);
        if (entry.type === "File") savedFileCount += 1;
      } catch (error) {
        validationError = error instanceof Error ? error : new Error("バックアップの内容が不正です");
      }
    },
  });
  if (validationError) throw validationError;
  if (savedFileCount === 0) throw new Error("バックアップにSavedデータがありません");
}

async function isValidBackupArchive(archivePath: string) {
  try {
    await inspectBackupArchive(archivePath);
    return true;
  } catch {
    return false;
  }
}

async function findBackupDirectories(directory: string, relativePath = ""): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const found: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const childPath = relativePath ? `${relativePath}/${entry.name}` : entry.name;
    if (entry.name === "backup") found.push(childPath);
    else found.push(...await findBackupDirectories(join(directory, entry.name), childPath));
  }
  return found;
}

async function restoreSavedData(archivePath: string) {
  await inspectBackupArchive(archivePath);

  const restoreWorkspace = join(palworldDirectory, `.palui-restore-${randomUUID()}`);
  const stagedSavedDirectory = join(restoreWorkspace, "Saved");
  const currentSavedDirectory = join(palworldDirectory, "Pal", "Saved");
  const recoveryDirectory = join(backupDirectory, `restore-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`);
  let hadCurrentSaved = false;
  let recoveryCreated = false;
  let replacementStarted = false;

  await mkdir(restoreWorkspace, { recursive: true });
  try {
    await tar.x({
      file: archivePath,
      cwd: restoreWorkspace,
      strict: true,
      preservePaths: false,
      filter(entryPath, entry) {
        if (!("type" in entry)) return false;
        try {
          validateBackupEntry(entryPath, entry.type);
          return true;
        } catch {
          return false;
        }
      },
    });

    const stagedInfo = await lstat(stagedSavedDirectory);
    if (!stagedInfo.isDirectory()) throw new Error("展開したSavedデータがディレクトリではありません");

    let currentInfo;
    try {
      currentInfo = await lstat(currentSavedDirectory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (currentInfo) {
      if (!currentInfo.isDirectory()) throw new Error("現在のSavedデータがディレクトリではありません");
      hadCurrentSaved = true;
      await mkdir(backupDirectory, { recursive: true });
      await cp(currentSavedDirectory, recoveryDirectory, { recursive: true, errorOnExist: true, force: false });
      recoveryCreated = true;

      for (const backupRelativePath of await findBackupDirectories(currentSavedDirectory)) {
        const stagedBackupDirectory = join(stagedSavedDirectory, ...backupRelativePath.split("/"));
        await rm(stagedBackupDirectory, { recursive: true, force: true });
        await mkdir(dirname(stagedBackupDirectory), { recursive: true });
        await cp(join(currentSavedDirectory, ...backupRelativePath.split("/")), stagedBackupDirectory, { recursive: true });
      }
    }

    await mkdir(dirname(currentSavedDirectory), { recursive: true });
    replacementStarted = true;
    await rm(currentSavedDirectory, { recursive: true, force: true });
    await rename(stagedSavedDirectory, currentSavedDirectory);
    if (recoveryCreated) await rm(recoveryDirectory, { recursive: true, force: true }).catch(() => undefined);
  } catch (error) {
    try {
      if (replacementStarted) {
        await rm(currentSavedDirectory, { recursive: true, force: true });
        if (hadCurrentSaved) await cp(recoveryDirectory, currentSavedDirectory, { recursive: true });
      }
    } catch {
      throw new Error(`復元に失敗し、元のセーブを自動復旧できませんでした。退避先: ${recoveryDirectory}`);
    } finally {
      if (!recoveryCreated) await rm(recoveryDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
    throw error;
  } finally {
    await rm(restoreWorkspace, { recursive: true, force: true });
  }
}

async function assertRestoreOwnership() {
  let composeEnvironment: Record<string, string> = {};
  try {
    composeEnvironment = parseDotenv(await readFile(`${settingsRoot}/.env`, "utf8"));
  } catch {
    // Compose defaults to uid/gid 1000 unless inherited values override them.
  }
  const expectedUid = Number(composeEnvironment.PUID ?? process.env.PUID ?? 1000);
  const expectedGid = Number(composeEnvironment.PGID ?? process.env.PGID ?? 1000);
  if ((typeof process.getuid === "function" && process.getuid() !== expectedUid)
    || (typeof process.getgid === "function" && process.getgid() !== expectedGid)) {
    throw new BackupError("PALUIとPalworldのPUID/PGIDが一致しないため復元できません", 409);
  }
}

type RestoreProgress = (message: string) => void;

function reportComposeOutput(label: string, result: { stdout: string; stderr: string }, onProgress?: RestoreProgress) {
  if (result.stdout.trim()) onProgress?.(`${label} stdout:\n${result.stdout.trim().slice(-8000)}`);
  if (result.stderr.trim()) onProgress?.(`${label} stderr:\n${result.stderr.trim().slice(-8000)}`);
}

function describeComposeError(error: unknown) {
  if (!error || typeof error !== "object") return String(error);
  const processError = error as { message?: unknown; stdout?: unknown; stderr?: unknown };
  return [processError.stderr, processError.stdout, processError.message]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join("\n")
    .slice(-8000);
}

export async function restoreBackup(name: string, startAfterRestore = false, onProgress?: RestoreProgress) {
  if (!/^[a-zA-Z0-9._-]+\.tar\.gz$/.test(name)) throw new BackupError("不正なバックアップ名です", 400);
  return withComposeOperation(async () => {
    const archivePath = join(backupDirectory, name);
    onProgress?.("バックアップファイルを検証しています");
    let archiveInfo;
    try {
      archiveInfo = await lstat(archivePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new BackupError("バックアップファイルが見つかりません", 404);
      throw error;
    }
    if (!archiveInfo.isFile()) throw new BackupError("バックアップファイルが見つかりません", 404);
    try {
      await inspectBackupArchive(archivePath);
    } catch {
      throw new BackupError("アーカイブが破損しているか、安全な復元形式ではありません", 422);
    }
    onProgress?.("バックアップファイルの検証が完了しました");
    await assertRestoreOwnership();
    onProgress?.("Compose停止を実行しています: docker compose down");
    try {
      const result = await runCompose(["down"], 120_000);
      reportComposeOutput("docker compose down", result, onProgress);
      onProgress?.("Compose停止コマンドが完了しました");
    } catch (error) {
      onProgress?.(`Compose停止コマンドでエラーが発生しました:\n${describeComposeError(error)}`);
      throw error;
    }
    const stoppedSnapshot = await readComposeServiceSnapshot("pal");
    if (stoppedSnapshot.state === "running" || stoppedSnapshot.state === "starting") {
      throw new Error("サーバー停止を確認できないため、復元を中止しました");
    }

    onProgress?.("Palworld停止を確認しました。Savedデータを展開・置換しています");
    try {
      await restoreSavedData(archivePath);
      onProgress?.("Savedデータの復元が完了しました");
    } catch (error) {
      onProgress?.(`Savedデータの復元でエラーが発生しました: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
    let started = false;
    let startError: string | null = null;
    if (startAfterRestore) {
      const startupStartedAt = new Date().toISOString();
      onProgress?.("Compose起動を実行しています: docker compose up -d");
      try {
        const result = await runCompose(["up", "-d"], 120_000);
        reportComposeOutput("docker compose up -d", result, onProgress);
        started = true;
        onProgress?.("Compose起動コマンドが完了しました");
      } catch (error) {
        onProgress?.(`Compose起動コマンドでエラーが発生しました:\n${describeComposeError(error)}`);
        const snapshot = await readComposeServiceSnapshot("pal").catch(() => null);
        if (snapshot && (snapshot.state === "running" || snapshot.state === "starting")) {
          started = true;
          startError = `Composeの起動処理は一部でエラーになりましたが、Palworldコンテナは${snapshot.state === "running" ? "起動しています" : "起動処理中です"}`;
          onProgress?.(`起動後の状態確認: Palworldコンテナは${snapshot.state === "running" ? "起動しています" : "起動処理中です"}`);
        } else {
          startError = "復元は完了しましたが、Composeを起動できませんでした";
          onProgress?.("起動後の状態確認: Palworldコンテナは起動していません");
        }
      }
      if (started) {
        try {
          onProgress?.("今回の起動以降のPalworldログを取得しています");
          const logs = await runCompose(["logs", "--no-color", "--since", startupStartedAt, "--tail", "100", "pal"], 15_000);
          reportComposeOutput("Palworld直近100行", logs, onProgress);
        } catch (error) {
          onProgress?.(`Palworldログを取得できませんでした: ${describeComposeError(error)}`);
        }
      }
    } else {
      onProgress?.("Compose起動は選択されていません。サーバーを停止状態のままにします");
    }
    return { restored: true, name, started, requiresManualStart: !started, startError };
  });
}

export async function deleteBackup(name: string) {
  if (!/^[a-zA-Z0-9._-]+\.tar\.gz$/.test(name)) throw new BackupError("不正なバックアップ名です", 400);
  return withComposeOperation(async () => {
    try {
      await unlink(join(backupDirectory, name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new BackupError("バックアップファイルが見つかりません", 404);
      throw error;
    }
    return { deleted: true, name };
  });
}

type SettingType = "BOOL" | "INT" | "FLOAT" | "STR" | "PASSWORD" | "ARRAY" | "CHOICE" | "SELECT";
type SettingMetadata = { label: string; description: string; type: SettingType; heading?: string; collapsible?: boolean; section?: number; min?: number; max?: number; options?: string[] };

function parseTypeSpec(spec: string): Pick<SettingMetadata, "type" | "min" | "max" | "options"> {
  const range = spec.match(/^(INT|FLOAT)\((-?[\d.]+),(-?[\d.]+)\)$/);
  if (range) return { type: range[1] as "INT" | "FLOAT", min: Number(range[2]), max: Number(range[3]) };
  const choices = spec.match(/^(CHOICE|SELECT)\((.*)\)$/);
  if (choices) return { type: choices[1] as "CHOICE" | "SELECT", options: choices[2].split(",").map((option) => option.trim()).filter(Boolean) };
  const type = ["BOOL", "INT", "FLOAT", "STR", "PASSWORD", "ARRAY"].includes(spec) ? spec : "STR";
  return { type: type as SettingType };
}

function parseDefaultSettings(content: string) {
  const values: Record<string, { defaultValue: string; metadata: SettingMetadata }> = {};
  let heading = "";
  let collapsible = false;
  let section = 0;
  let pending: SettingMetadata | undefined;
  for (const line of content.split("\n")) {
    const headingMatch = line.match(/^#(\*{1,3})(?!\*)\s*(.*)$/);
    if (headingMatch) {
      if (headingMatch[1].length === 1) { heading = headingMatch[2].trim(); collapsible = false; }
      else if (headingMatch[1].length === 2) { heading = headingMatch[2].trim(); collapsible = true; section += 1; }
      continue;
    }
    const metadataMatch = line.match(/^#\|([^|]*)\|([^|]*)\|(.*)$/);
    if (metadataMatch) {
      pending = { label: metadataMatch[1].trim(), description: metadataMatch[3].trim(), ...parseTypeSpec(metadataMatch[2].trim()) };
      continue;
    }
    const valueMatch = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)\s*$/);
    if (valueMatch) {
      const key = valueMatch[1];
      const metadata = pending ?? { label: key, description: "", type: "STR" as SettingType };
      values[key] = { defaultValue: valueMatch[2].replace(/^"|"$/g, ""), metadata: heading ? { ...metadata, heading, collapsible, section: collapsible ? section : undefined } : metadata };
      pending = undefined;
    }
  }
  return values;
}

function validateSetting(value: string, metadata: SettingMetadata) {
  if (metadata.type === "BOOL" && !["true", "false", "True", "False"].includes(value)) throw new Error(`${metadata.label}: BOOL の値が不正です`);
  if (metadata.type === "INT" || metadata.type === "FLOAT") {
    const number = Number(value);
    if (!Number.isFinite(number) || (metadata.type === "INT" && !Number.isInteger(number))) throw new Error(`${metadata.label}: 数値の形式が不正です`);
    if (metadata.min !== undefined && number < metadata.min || metadata.max !== undefined && number > metadata.max) throw new Error(`${metadata.label}: 範囲外です`);
  }
  if (metadata.type === "CHOICE" && metadata.options && !metadata.options.includes(value)) throw new Error(`${metadata.label}: 選択肢が不正です`);
  if (metadata.type === "SELECT" && metadata.options) {
    const selected = value.trim().replace(/^"|"$/g, "").replace(/^\(|\)$/g, "").split(",").map((item) => item.trim()).filter(Boolean);
    if (selected.some((item) => !metadata.options?.includes(item))) throw new Error(`${metadata.label}: 選択肢が不正です`);
  }
}

type SettingsTarget = typeof settingsTargets[number];

async function readSettingsContents(): Promise<Record<SettingsTarget, string>> {
  const entries = await Promise.all(settingsTargets.map(async (target) => [target, await readFile(`${settingsRoot}/${target}`, "utf8").catch(() => "")] as const));
  return Object.fromEntries(entries) as Record<SettingsTarget, string>;
}

function settingsHash(contents: Record<SettingsTarget, string>) {
  const stableContents = settingsTargets.map((target) => [target, contents[target]]);
  return createHash("sha256").update(JSON.stringify(stableContents)).digest("hex");
}

function inlineComment(value: string) {
  let quote = "";
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (escaped) { escaped = false; continue; }
    if (character === "\\" && quote === '"') { escaped = true; continue; }
    if (quote) { if (character === quote) quote = ""; continue; }
    if (character === '"' || character === "'") { quote = character; continue; }
    if (character === "#" && index > 0 && /\s/.test(value[index - 1])) {
      let commentStart = index;
      while (commentStart > 0 && /\s/.test(value[commentStart - 1])) commentStart -= 1;
      return value.slice(commentStart);
    }
  }
  return "";
}

function updateDotenv(content: string, changes: Map<string, string | null>, header = "") {
  const current = parseDotenv(content);
  for (const key of changes.keys()) {
    if (/[\r\n]/.test(current[key] ?? "")) throw new Error(`${key}: 複数行の値は設定画面から更新できません`);
  }

  const lines = content.match(/[^\n]*(?:\n|$)/g)?.filter(Boolean) ?? [];
  const found = new Set<string>();
  const updatedLines = lines.flatMap((line) => {
    const body = line.replace(/\r?\n$/, "");
    const ending = line.slice(body.length);
    const match = body.match(/^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_]*)(\s*=\s*)(.*)$/);
    if (!match || !changes.has(match[2])) return [line];
    found.add(match[2]);
    const value = changes.get(match[2]);
    const comment = inlineComment(match[4]);
    if (value === null) {
      const indentation = match[1].match(/^\s*/)?.[0] ?? "";
      return comment ? [`${indentation}${comment.trimStart()}${ending}`] : [];
    }
    return [`${match[1]}${match[2]}${match[3]}${JSON.stringify(value)}${comment}${ending}`];
  });

  const additions = [...changes].filter(([key, value]) => value !== null && !found.has(key));
  if (additions.length === 0) return updatedLines.join("");
  const newline = content.includes("\r\n") ? "\r\n" : "\n";
  let result = updatedLines.join("");
  if (!result && header) result = header;
  if (result && !result.endsWith("\n")) result += newline;
  if (result && header && result === header && !result.endsWith("\n")) result += newline;
  return `${result}${additions.map(([key, value]) => `${key}=${JSON.stringify(value)}${newline}`).join("")}`;
}

async function writeSettingsFile(target: SettingsTarget, content: string) {
  const file = `${settingsRoot}/${target}`;
  const mode = await stat(file).then((info) => info.mode & 0o777).catch(() => target === ".env" ? 0o600 : 0o644);
  const temporaryFile = `${file}.tmp-${process.pid}-${randomUUID()}`;
  let fileHandle;
  try {
    fileHandle = await open(temporaryFile, "wx", mode);
    await fileHandle.writeFile(content, "utf8");
    await fileHandle.sync();
    await fileHandle.close();
    fileHandle = undefined;
    await rename(temporaryFile, file);
  } catch (error) {
    await fileHandle?.close().catch(() => undefined);
    await unlink(temporaryFile).catch(() => undefined);
    throw error;
  }
}

export async function readSettings() {
  const fileContents = await readSettingsContents();
  const parsedFiles = Object.fromEntries(settingsTargets.map((target) => [target, parseDotenv(fileContents[target])])) as Record<SettingsTarget, Record<string, string>>;
  const categories = await Promise.all(Object.entries(settingsFiles).map(async ([category, definition]) => {
    const content = await readFile(`${settingsRoot}/${definition.defaults}`, "utf8").catch(() => "");
    const defaults = parseDefaultSettings(content);
    const current = parsedFiles[definition.target];
    return {
      category,
      values: Object.entries(defaults).map(([key, setting]) => ({ key, value: current[key] ?? setting.defaultValue, defaultValue: setting.defaultValue, overridden: key in current, secret: setting.metadata.type === "PASSWORD" || /PASSWORD|TOKEN|SECRET|KEY/i.test(key), ...setting.metadata })),
    };
  }));
  return { categories, hash: settingsHash(fileContents), overridden: Object.values(parsedFiles).reduce((count, values) => count + Object.keys(values).length, 0) };
}

export async function saveSettings(values: Record<string, string>, expectedHash: string) {
  const currentContents = await readSettingsContents();
  if (settingsHash(currentContents) !== expectedHash) throw new Error("設定ファイルが外部変更されています");

  const settingsMetadata: Record<string, { defaultValue: string; metadata: SettingMetadata; target: SettingsTarget }> = {};
  for (const [category, definition] of Object.entries(settingsFiles)) {
    const content = await readFile(`${settingsRoot}/${definition.defaults}`, "utf8").catch(() => "");
    for (const [key, setting] of Object.entries(parseDefaultSettings(content))) settingsMetadata[key] = { ...setting, target: definition.target };
  }

  const changes = new Map<SettingsTarget, Map<string, string | null>>(settingsTargets.map((target) => [target, new Map()]));
  for (const [key, value] of Object.entries(values)) {
    const setting = settingsMetadata[key];
    if (!setting) continue;
    if (typeof value !== "string") throw new Error(`${key}: 設定値の形式が不正です`);
    validateSetting(value, setting.metadata);
    changes.get(setting.target)?.set(key, value === setting.defaultValue ? null : value);
  }

  const updatedContents: Record<SettingsTarget, string> = {
    ".env": updateDotenv(currentContents[".env"], changes.get(".env") ?? new Map()),
    "override.env": updateDotenv(currentContents["override.env"], changes.get("override.env") ?? new Map(), "# palui によって上書きされる設定ファイル\n"),
  };
  const written = new Map<SettingsTarget, string>();
  for (const target of settingsTargets) {
    if (updatedContents[target] === currentContents[target]) continue;
    const latestContents = await readSettingsContents();
    const expectedContents = { ...currentContents, ...Object.fromEntries(written) } as Record<SettingsTarget, string>;
    if (settingsHash(latestContents) !== settingsHash(expectedContents)) throw new Error("設定ファイルが外部変更されています");
    await writeSettingsFile(target, updatedContents[target]);
    written.set(target, updatedContents[target]);
  }
  return readSettings();
}

export async function readPalworldOverview(allowRestCommands = true) {
  const paused = await isPalworldPaused();
  if (!allowRestCommands || paused) {
    return { paused, info: null, metrics: null, errors: { info: null, metrics: null } };
  }
  const [infoResult, metricsResult] = await Promise.allSettled([
    execPalworldCli("info"),
    execPalworldCli("metrics"),
  ]);
  const pausedDuringRequest = [infoResult, metricsResult].some((result) => result.status === "rejected" && result.reason instanceof PalworldPausedError);

  return {
    paused: paused || pausedDuringRequest,
    info: infoResult.status === "fulfilled" ? infoResult.value as PalworldInfo : null,
    metrics: metricsResult.status === "fulfilled" ? metricsResult.value as PalworldMetrics : null,
    errors: {
      info: infoResult.status === "rejected" && !(infoResult.reason instanceof PalworldPausedError) ? "rest-cli info を取得できませんでした" : null,
      metrics: metricsResult.status === "rejected" && !(metricsResult.reason instanceof PalworldPausedError) ? "rest-cli metrics を取得できませんでした" : null,
    },
  };
}

export async function setAutoPause(enabled: boolean) {
  // AUTO PAUSE の切替は許可した2コマンドだけを実行し、任意のサブコマンドを受け付けない。
  const command = enabled ? "continue" : "stop";
  await runPalworldCommand(["autopause", command]);
  return { enabled };
}