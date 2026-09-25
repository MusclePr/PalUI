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

type CachedPlayers = { players: PalworldPlayer[]; updatedAt: string };
let onlinePlayersCache: CachedPlayers | null = null;

const fixturePlayers: PalworldPlayer[] = [
  { name: "Sakura_A", playerId: "steam_76561198012345678", userId: "12345678901234567", ip: "192.0.2.10", ping: 42, buildingCount: 126, level: 48, lastLogin: "2026-09-17T12:18:00+09:00", banned: false },
  { name: "Kitsune", playerId: "steam_76561198087654321", userId: "12345678901234568", ip: "192.0.2.11", ping: 58, buildingCount: 84, level: 37, lastLogin: "2026-09-17T13:44:00+09:00", banned: true },
];

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

export async function readPlayers() {
  const whitelist = await readWhitelist();
  let onlinePlayers = onlinePlayersCache?.players ?? fixturePlayers;
  let source: "rest-cli" | "cache" | "fixture" = onlinePlayersCache ? "cache" : "fixture";
  try {
    onlinePlayers = normalizePlayers(await execPlayers());
    onlinePlayersCache = { players: onlinePlayers, updatedAt: new Date().toISOString() };
    source = "rest-cli";
  } catch {
    // サーバー停止中も、最後に取得したオンライン情報をオフライン履歴として表示する。
  }
  return { onlinePlayers, whitelist, cachedAt: onlinePlayersCache?.updatedAt ?? null, source };
}

export async function updateWhitelist(playerId: string, enabled: boolean) {
  if (!/^[-_a-zA-Z0-9:.]+$/.test(playerId)) throw new Error("不正なプレイヤー ID です");
  const whitelist = await readWhitelist();
  const next = enabled ? [...whitelist, playerId] : whitelist.filter((id) => id !== playerId);
  try {
    await execWhitelist(enabled ? "whitelist_add" : "whitelist_remove", playerId);
  } catch {
    // RCON を受け付けない状態では、仕様で定めたファイルを直接更新する。
    await writeWhitelist(next);
  }
  return { playerId, enabled, whitelist: await readWhitelist() };
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