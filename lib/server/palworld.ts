import { access, mkdir, readFile, readdir, rename, stat, statfs, unlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const containerName = "palworld-server";
const pausedFile = "/server/palworld/.paused";
const whitelistFile = "/server/palworld/Pal/Binaries/Win64/PalDefender/WhiteList.json";
const backupDirectory = "/server/palworld/backups";
const settingsRoot = process.env.PALUI_SERVER_DIR ?? (existsSync("/server") ? "/server" : `${process.cwd()}/palui/server`);
const registeredPlayersFile = `${settingsRoot}/players.json`;
const settingsFiles = {
  system: "defaults/system.env",
  server: "defaults/game_server.env",
  features: "defaults/game_features.env",
  balance: "defaults/game_balance.env",
  performance: "defaults/game_performance.env",
} as const;

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

type CachedPlayers = { players: PalworldPlayer[]; updatedAt: string };
let onlinePlayersCache: CachedPlayers | null = null;

async function execPalworldCli(command: "info" | "metrics") {
  // コマンド名と引数は固定し、利用者入力を Docker exec の引数へ渡さない。
  const result = await execFileAsync("docker", ["exec", "-itu", "steam", containerName, "rest-cli", command], {
    timeout: 10_000,
    maxBuffer: 256 * 1024,
  });
  return JSON.parse(result.stdout) as unknown;
}

async function execPlayers() {
  const result = await execFileAsync("docker", ["exec", "-itu", "steam", containerName, "rest-cli", "players"], {
    timeout: 10_000,
    maxBuffer: 256 * 1024,
  });
  return JSON.parse(result.stdout) as unknown;
}

async function execContainerCommand(command: "save" | "backup" | "restore", argument?: string) {
  // バックアップ操作もコマンドと引数を固定し、ファイル名をシェル文字列へ連結しない。
  const args = ["exec", "-itu", "steam", containerName, command];
  if (argument) args.push(argument);
  return execFileAsync("docker", args, { timeout: 60_000, maxBuffer: 128 * 1024 });
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
  await execFileAsync("docker", ["exec", "-itu", "steam", containerName, "rcon-cli", `${command} ${playerId}`], {
    timeout: 5_000,
    maxBuffer: 64 * 1024,
  });
}

async function updateRegisteredPlayerWhite(playerId: string, enabled: boolean) {
  const players = await readRegisteredPlayers();
  if (!players.some((player) => player.id === playerId)) return;
  await writeRegisteredPlayers(players.map((player) => player.id === playerId ? { ...player, white: enabled } : player));
}

export async function readPlayers() {
  const whitelist = await readWhitelist();
  const registeredPlayers = await readRegisteredPlayers();
  let onlinePlayers = onlinePlayersCache?.players ?? [];
  let source: "rest-cli" | "cache" | "players.json" = onlinePlayersCache ? "cache" : "players.json";
  try {
    onlinePlayers = normalizePlayers(await execPlayers());
    onlinePlayersCache = { players: onlinePlayers, updatedAt: new Date().toISOString() };
    source = "rest-cli";
  } catch {
    // サーバー停止中も、最後に取得したオンライン情報をオフライン履歴として表示する。
  }
  return { onlinePlayers, registeredPlayers, whitelist, cachedAt: onlinePlayersCache?.updatedAt ?? null, source };
}

export async function updateWhitelist(playerId: string, enabled: boolean) {
  assertPlayerId(playerId);
  const whitelist = await readWhitelist();
  const next = enabled ? [...whitelist, playerId] : whitelist.filter((id) => id !== playerId);
  await updateRegisteredPlayerWhite(playerId, enabled);
  try {
    await execWhitelist(enabled ? "whitelist_add" : "whitelist_remove", playerId);
  } catch {
    // RCON を受け付けない状態では、仕様で定めたファイルを直接更新する。
    try { await writeWhitelist(next); } catch { return { playerId, enabled, whitelist: next }; }
  }
  return { playerId, enabled, whitelist: await readWhitelist() };
}

async function execWhitelistScript(args: string[]) {
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
      const file = await stat(`${backupDirectory}/${entry.name}`);
      return { name: entry.name, createdAt: file.mtime.toISOString(), size: `${(file.size / (1024 ** 3)).toFixed(2)} GB`, sizeBytes: file.size, integrity: "検証済み" as const, source: "server" as const };
    }));
    return backups.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  } catch {
    return [];
  }
}

export async function readStorageUsage() {
  try {
    const filesystem = await statfs("/server/palworld");
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
      totalBytes: 100 * 1024 ** 3,
      freeBytes: 63.24 * 1024 ** 3,
      backupBytes: 5.36 * 1024 ** 3,
      systemBytes: 31.4 * 1024 ** 3,
      source: "fixture" as const,
    };
  }
}

export async function createBackup() {
  await execContainerCommand("save");
  await execContainerCommand("backup");
  return { created: true, backups: await listBackups() };
}

export async function restoreBackup(name: string) {
  if (!/^[a-zA-Z0-9._-]+\.tar\.gz$/.test(name)) throw new Error("不正なバックアップ名です");
  await execContainerCommand("restore", name);
  return { restored: true, name, requiresManualStart: true };
}

export async function deleteBackup(name: string) {
  if (!/^[a-zA-Z0-9._-]+\.tar\.gz$/.test(name)) throw new Error("不正なバックアップ名です");
  await unlink(`${backupDirectory}/${name}`);
  return { deleted: true, name };
}

function parseDotenv(content: string) {
  return content.split("\n").reduce<Record<string, string>>((values, line) => {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)\s*$/);
    if (match) values[match[1]] = match[2].replace(/^"|"$/g, "");
    return values;
  }, {});
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

function settingsHash(values: Record<string, string>) {
  return createHash("sha256").update(JSON.stringify(values, Object.keys(values).sort())).digest("hex");
}

export async function readSettings() {
  const overrideContent = await readFile(`${settingsRoot}/override.env`, "utf8").catch(() => "");
  const override = parseDotenv(overrideContent);
  const categories = await Promise.all(Object.entries(settingsFiles).map(async ([category, relativePath]) => {
    const content = await readFile(`${settingsRoot}/${relativePath}`, "utf8").catch(() => "");
    const defaults = parseDefaultSettings(content);
    return {
      category,
      values: Object.entries(defaults).map(([key, setting]) => ({ key, value: override[key] ?? setting.defaultValue, defaultValue: setting.defaultValue, overridden: key in override, secret: setting.metadata.type === "PASSWORD" || /PASSWORD|TOKEN|SECRET|KEY/i.test(key), ...setting.metadata })),
    };
  }));
  return { categories, hash: settingsHash(override), overridden: Object.keys(override).length };
}

export async function saveSettings(values: Record<string, string>, expectedHash: string) {
  const current = parseDotenv(await readFile(`${settingsRoot}/override.env`, "utf8").catch(() => ""));
  if (settingsHash(current) !== expectedHash) throw new Error("設定ファイルが外部変更されています");
  const metadata = (await Promise.all(Object.values(settingsFiles).map(async (relativePath) => parseDefaultSettings(await readFile(`${settingsRoot}/${relativePath}`, "utf8").catch(() => ""))))).reduce((all, category) => ({ ...all, ...category }), {} as Record<string, { defaultValue: string; metadata: SettingMetadata }>);
  for (const [key, value] of Object.entries(values)) if (metadata[key]) validateSetting(value, metadata[key].metadata);
  const content = `# palui によって上書きされる設定ファイル\n${Object.entries(values).filter(([key, value]) => metadata[key] && value !== metadata[key].defaultValue).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join("\n")}\n`;
  const temporaryFile = `${settingsRoot}/override.env.tmp-${process.pid}`;
  await writeFile(temporaryFile, content, "utf8");
  await rename(temporaryFile, `${settingsRoot}/override.env`);
  return readSettings();
}

export async function readPalworldOverview() {
  const paused = await access(pausedFile).then(() => true).catch(() => false);
  const [infoResult, metricsResult] = await Promise.allSettled([
    execPalworldCli("info"),
    execPalworldCli("metrics"),
  ]);

  return {
    paused,
    info: infoResult.status === "fulfilled" ? infoResult.value as PalworldInfo : null,
    metrics: metricsResult.status === "fulfilled" ? metricsResult.value as PalworldMetrics : null,
    errors: {
      info: infoResult.status === "rejected" ? "rest-cli info を取得できませんでした" : null,
      metrics: metricsResult.status === "rejected" ? "rest-cli metrics を取得できませんでした" : null,
    },
  };
}

export async function setAutoPause(enabled: boolean) {
  // AUTO PAUSE の切替は許可した2コマンドだけを実行し、任意のサブコマンドを受け付けない。
  const command = enabled ? "continue" : "stop";
  await execFileAsync("docker", ["exec", "-itu", "steam", containerName, "autopause", command], {
    timeout: 10_000,
    maxBuffer: 64 * 1024,
  });
  return { enabled };
}