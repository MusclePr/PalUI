import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { access, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ComposeServiceSnapshot, PalworldStatus } from "./compose";

type DashboardCachedContainer = Omit<ComposeServiceSnapshot, "service"> & { service: "pal" };
type DashboardMetrics = { currentplayernum: number; maxplayernum: number; serverfps: number; serverfpsaverage: number; days: number };
export type DashboardStateCache = {
  container: DashboardCachedContainer;
  serverStatus: PalworldStatus | null;
  paused: boolean;
  autoPauseEnabled: boolean | null;
  metrics: DashboardMetrics | null;
  lastRefreshAt: string;
  lastStatsAt: string | null;
  lastMetricsAt: string | null;
};
export type DashboardCache = {
  version: string | null;
  servername: string | null;
  description: string | null;
  days: number | null;
  updatedAt: string | null;
  snapshot: DashboardStateCache | null;
};

type DashboardCacheUpdate = Partial<Pick<DashboardCache, "version" | "servername" | "description" | "days" | "snapshot">>;

const serverDirectory = process.env.PALUI_SERVER_DIR ?? (existsSync("/server") ? "/server" : resolve(process.cwd(), "palui/server"));
const cacheFile = join(serverDirectory, ".dashboard-cache.json");
let writeQueue: Promise<void> = Promise.resolve();

function emptyDashboardCache(): DashboardCache {
  return { version: null, servername: null, description: null, days: null, updatedAt: null, snapshot: null };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isNullableNumber(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value));
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isNullableTimestamp(value: unknown): value is string | null {
  return value === null || isTimestamp(value);
}

function isContainerState(value: unknown): value is ComposeServiceSnapshot["state"] {
  return value === "not_created" || value === "running" || value === "stopped" || value === "starting" || value === "unknown";
}

function isPalworldStatus(value: unknown): value is PalworldStatus["status"] {
  return value === "starting" || value === "updating" || value === "running" || value === "stopping" || value === "paused" || value === "stopped";
}

function isDashboardMetrics(value: unknown): value is DashboardMetrics | null {
  return value === null || (isRecord(value)
    && typeof value.currentplayernum === "number" && Number.isFinite(value.currentplayernum)
    && typeof value.maxplayernum === "number" && Number.isFinite(value.maxplayernum)
    && typeof value.serverfps === "number" && Number.isFinite(value.serverfps)
    && typeof value.serverfpsaverage === "number" && Number.isFinite(value.serverfpsaverage)
    && typeof value.days === "number" && Number.isFinite(value.days));
}

function isDashboardStateCache(value: unknown): value is DashboardStateCache {
  if (!isRecord(value) || !isRecord(value.container)) return false;
  const container = value.container;
  const serverStatus = value.serverStatus;
  return container.service === "pal"
    && isContainerState(container.state)
    && isNullableString(container.name)
    && isNullableString(container.image)
    && isNullableString(container.startedAt)
    && isNullableNumber(container.restartCount)
    && isNullableNumber(container.cpuPercent)
    && isNullableNumber(container.memoryUsageBytes)
    && isNullableNumber(container.memoryLimitBytes)
    && isNullableString(container.statsError)
    && (serverStatus === null || (isRecord(serverStatus)
      && isPalworldStatus(serverStatus.status)
      && typeof serverStatus.progress === "number"
      && Number.isFinite(serverStatus.progress)
      && serverStatus.progress >= 0
      && serverStatus.progress <= 100))
    && typeof value.paused === "boolean"
    && (value.autoPauseEnabled === null || typeof value.autoPauseEnabled === "boolean")
    && isDashboardMetrics(value.metrics)
    && isTimestamp(value.lastRefreshAt)
    && isNullableTimestamp(value.lastStatsAt)
    && isNullableTimestamp(value.lastMetricsAt);
}

function mergeDashboardState(previous: DashboardStateCache | null, next: DashboardStateCache): DashboardStateCache {
  if (!previous) return next;
  const unavailable = next.container.state === "unknown";
  const clearServerStatus = !unavailable && next.serverStatus === null;
  return {
    ...next,
    container: unavailable
      ? { ...previous.container, statsError: next.container.statsError }
      : {
          ...next.container,
          cpuPercent: next.container.cpuPercent ?? previous.container.cpuPercent,
          memoryUsageBytes: next.container.memoryUsageBytes ?? previous.container.memoryUsageBytes,
          memoryLimitBytes: next.container.memoryLimitBytes ?? previous.container.memoryLimitBytes,
        },
    serverStatus: clearServerStatus ? null : next.serverStatus ?? previous.serverStatus,
    autoPauseEnabled: next.autoPauseEnabled ?? previous.autoPauseEnabled,
    metrics: next.metrics ?? previous.metrics,
    lastStatsAt: next.lastStatsAt ?? previous.lastStatsAt,
    lastMetricsAt: next.lastMetricsAt ?? previous.lastMetricsAt,
  };
}

function parseDashboardCache(value: unknown): DashboardCache {
  if (!isRecord(value)) return emptyDashboardCache();
  return {
    version: typeof value.version === "string" ? value.version : null,
    servername: typeof value.servername === "string" ? value.servername : null,
    description: typeof value.description === "string" ? value.description : null,
    days: typeof value.days === "number" && Number.isFinite(value.days) && value.days >= 0 ? value.days : null,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : null,
    snapshot: isDashboardStateCache(value.snapshot) ? value.snapshot : null,
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
    if (key === "snapshot") return isDashboardStateCache(value);
    return typeof value === "string" && value.trim().length > 0;
  })) as DashboardCacheUpdate;
  if (Object.keys(updates).length === 0) return readDashboardCache();

  return queueCacheWrite(async () => {
    const current = await readDashboardCache();
    const cache = {
      ...current,
      ...updates,
      snapshot: updates.snapshot ? mergeDashboardState(current.snapshot, updates.snapshot) : current.snapshot,
      updatedAt: new Date().toISOString(),
    };
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