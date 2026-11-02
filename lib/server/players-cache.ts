import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { PalworldPlayer } from "./palworld";

const serverDirectory = process.env.PALUI_SERVER_DIR ?? (existsSync("/server") ? "/server" : resolve(process.cwd(), "palui/server"));
const cacheFile = join(serverDirectory, ".players-cache.json");
const lockFile = join(serverDirectory, ".players-write.lock");

export type PlayersCache = {
  onlinePlayers: PalworldPlayer[];
  cachedAt: string | null;
  error: string | null;
};

export class PlayersCacheFormatError extends Error {}

export async function readPlayersCache(): Promise<PlayersCache> {
  try {
    const contents = await readFile(cacheFile, "utf8");
    try {
      const value: unknown = JSON.parse(contents);
      if (!value || typeof value !== "object" || !("onlinePlayers" in value) || !Array.isArray(value.onlinePlayers)
        || !("cachedAt" in value) || !(value.cachedAt === null || typeof value.cachedAt === "string")
        || !("error" in value) || !(value.error === null || typeof value.error === "string")) {
        throw new PlayersCacheFormatError("プレイヤーキャッシュの形式が不正です");
      }
      return { onlinePlayers: parseProxyPlayers({ players: value.onlinePlayers }), cachedAt: value.cachedAt, error: value.error };
    } catch (error) {
      throw new PlayersCacheFormatError("プレイヤーキャッシュの形式が不正です", { cause: error });
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { onlinePlayers: [], cachedAt: null, error: null };
    throw error;
  }
}

export function parseProxyPlayers(value: unknown): PalworldPlayer[] {
  if (!value || typeof value !== "object" || !("players" in value) || !Array.isArray(value.players)) {
    throw new Error("プレイヤーProxyの応答形式が不正です");
  }
  const players = value.players.map((item: unknown): PalworldPlayer => {
    if (!item || typeof item !== "object" || !("playerId" in item) || typeof item.playerId !== "string" || !item.playerId
      || !("userId" in item) || typeof item.userId !== "string" || !("name" in item) || typeof item.name !== "string") {
      throw new Error("プレイヤーProxyのプレイヤー情報が不正です");
    }
    const player = item as Record<string, unknown>;
    const number = (key: string, fallback?: string) => {
      const raw = player[key] ?? (fallback ? player[fallback] : undefined) ?? 0;
      if (typeof raw !== "number" || !Number.isFinite(raw)) throw new Error("プレイヤーProxyの数値が不正です");
      return raw;
    };
    return {
      name: item.name, playerId: item.playerId, userId: item.userId,
      accountName: typeof player.accountName === "string" ? player.accountName : "",
      ip: typeof player.ip === "string" ? player.ip : "",
      ping: number("ping"), buildingCount: number("buildingCount", "building_count"), level: number("level"),
      lastLogin: null, banned: false,
    };
  });
  const keys = new Set<string>();
  for (const player of players) {
    const key = JSON.stringify(player.userId ? ["user", player.userId] : ["player", player.playerId]);
    if (keys.has(key)) throw new Error("プレイヤーProxyの識別子が重複しています");
    keys.add(key);
  }
  return players.sort((left, right) => (left.userId || left.playerId).localeCompare(right.userId || right.playerId));
}

export async function writePlayersCache(cache: PlayersCache, previous?: PlayersCache | null) {
  const current = previous === undefined ? await readPlayersCache() : previous;
  if (JSON.stringify(current) === JSON.stringify(cache)) return;
  await mkdir(serverDirectory, { recursive: true });
  const temporary = `${cacheFile}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeAtomicFile(temporary, cacheFile, `${JSON.stringify(cache)}\n`);
  } finally {
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

async function writeAtomicFile(temporary: string, target: string, contents: string) {
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, target);
}

export async function withPlayersLock<T>(operation: () => Promise<T>): Promise<T> {
  await mkdir(serverDirectory, { recursive: true });
  const deadline = Date.now() + 70_000;
  for (;;) {
    let handle;
    try {
      handle = await open(lockFile, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const owner = Number(await readFile(lockFile, "utf8"));
        if (Number.isInteger(owner) && owner > 0) {
          try { process.kill(owner, 0); } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
            await unlink(lockFile);
            continue;
          }
        } else if (Date.now() - (await stat(lockFile)).mtimeMs > 300_000) {
          await unlink(lockFile);
          continue;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      if (Date.now() >= deadline) throw new Error("プレイヤー情報の更新ロックがタイムアウトしました");
      await new Promise((resolve) => setTimeout(resolve, 50));
      continue;
    }
    try {
      await handle.writeFile(String(process.pid));
      return await operation();
    } finally {
      await handle.close();
      await unlink(lockFile);
    }
  }
}
