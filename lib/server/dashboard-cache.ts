import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { access, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";

export type DashboardCache = {
  version: string | null;
  servername: string | null;
  description: string | null;
  days: number | null;
  updatedAt: string | null;
};

type DashboardCacheUpdate = Partial<Pick<DashboardCache, "version" | "servername" | "description" | "days">>;

const serverDirectory = process.env.PALUI_SERVER_DIR ?? (existsSync("/server") ? "/server" : resolve(process.cwd(), "palui/server"));
const cacheFile = join(serverDirectory, ".dashboard-cache.json");
let writeQueue: Promise<void> = Promise.resolve();

function emptyDashboardCache(): DashboardCache {
  return { version: null, servername: null, description: null, days: null, updatedAt: null };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseDashboardCache(value: unknown): DashboardCache {
  if (!isRecord(value)) return emptyDashboardCache();
  return {
    version: typeof value.version === "string" ? value.version : null,
    servername: typeof value.servername === "string" ? value.servername : null,
    description: typeof value.description === "string" ? value.description : null,
    days: typeof value.days === "number" && Number.isFinite(value.days) && value.days >= 0 ? value.days : null,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : null,
  };
}

export async function readDashboardCache(): Promise<DashboardCache> {
  try {
    return parseDashboardCache(JSON.parse(await readFile(cacheFile, "utf8")) as unknown);
  } catch {
    return emptyDashboardCache();
  }
}

function queueCacheWrite<T>(operation: () => Promise<T>) {
  const pending = writeQueue.then(operation);
  writeQueue = pending.then(() => undefined, () => undefined);
  return pending;
}

export async function updateDashboardCache(values: DashboardCacheUpdate): Promise<DashboardCache> {
  const updates = Object.fromEntries(Object.entries(values).filter(([key, value]) => {
    if (key === "days") return typeof value === "number" && Number.isFinite(value) && value >= 0;
    return typeof value === "string" && value.trim().length > 0;
  })) as DashboardCacheUpdate;
  if (Object.keys(updates).length === 0) return readDashboardCache();

  return queueCacheWrite(async () => {
    const cache = { ...await readDashboardCache(), ...updates, updatedAt: new Date().toISOString() };
    await mkdir(serverDirectory, { recursive: true });
    const temporaryFile = join(serverDirectory, `.dashboard-cache.${process.pid}.${randomUUID()}.tmp`);
    let fileHandle;
    try {
      fileHandle = await open(temporaryFile, "wx", 0o600);
      await fileHandle.writeFile(`${JSON.stringify(cache)}\n`, "utf8");
      await fileHandle.sync();
      await fileHandle.close();
      fileHandle = undefined;
      await rename(temporaryFile, cacheFile);
    } catch (error) {
      await fileHandle?.close().catch(() => undefined);
      await unlink(temporaryFile).catch(() => undefined);
      throw error;
    }
    return cache;
  });
}