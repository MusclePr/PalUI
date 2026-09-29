import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const composeDirectory = process.env.PALUI_SERVER_DIR ?? (existsSync("/server") ? "/server" : resolve(process.cwd(), "palui/server"));
const composeFile = join(composeDirectory, "compose.yml");
const composePrefix = ["compose", "--project-directory", composeDirectory, "--file", composeFile];
const activeLifecycleOperations = new Set<string>();
let palReadinessCacheKey: string | null = null;
let palReadyMarkerDetected = false;

export const composeServices = ["pal", "proxy", "map"] as const;
export type ComposeService = typeof composeServices[number];
export type ComposeLifecycleAction = "start" | "stop" | "restart";
export type ComposeServiceState = "not_created" | "running" | "stopped" | "starting" | "unknown";

export type ComposeServiceSnapshot = {
  service: ComposeService;
  state: ComposeServiceState;
  name: string | null;
  image: string | null;
  startedAt: string | null;
  restartCount: number | null;
  cpuPercent: number | null;
  memoryUsageBytes: number | null;
  memoryLimitBytes: number | null;
  statsError: string | null;
};

export class PalworldPausedError extends Error {
  constructor() {
    super("AUTO PAUSE中のためREST APIとRCONを実行できません");
    this.name = "PalworldPausedError";
  }
}

export class ComposeOperationInProgressError extends Error {
  constructor() {
    super("Composeのライフサイクル操作は既に実行中です");
    this.name = "ComposeOperationInProgressError";
  }
}

export function isComposeService(value: unknown): value is ComposeService {
  return typeof value === "string" && composeServices.includes(value as ComposeService);
}

export function hasPalworldReadyMarker(logs: string) {
  return /REST API started on port\s+\d+/i.test(logs);
}

export async function isPalworldPaused() {
  try {
    await access(join(composeDirectory, "palworld", ".paused"));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export function composeCommand(args: readonly string[]) {
  return {
    command: "docker",
    args: [...composePrefix, ...args],
    cwd: composeDirectory,
  };
}

export async function runCompose(args: readonly string[], timeoutMs = 120_000) {
  const command = composeCommand(args);
  return execFileAsync(command.command, command.args, {
    cwd: command.cwd,
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024,
    encoding: "utf8",
  });
}

export async function runPalworldCommand(args: readonly string[], timeoutMs = 10_000, execute: ComposeExecutor = runCompose) {
  if ((args[0] === "rest-cli" || args[0] === "rcon-cli") && await isPalworldPaused()) {
    throw new PalworldPausedError();
  }
  return execute(["exec", "-T", "-u", "steam", "pal", ...args], timeoutMs);
}

export async function resumePalworldIfPaused(execute: ComposeExecutor = runCompose) {
  if (!await isPalworldPaused()) return false;

  await execute(["exec", "-T", "-u", "steam", "pal", "autopause", "resume"], 10_000);
  if (await isPalworldPaused()) throw new PalworldPausedError();
  return true;
}

export async function runPalworldRconCommand(args: readonly string[], timeoutMs = 10_000, execute: ComposeExecutor = runCompose) {
  await resumePalworldIfPaused(execute);
  return execute(["exec", "-T", "-u", "steam", "pal", "rcon-cli", ...args], timeoutMs);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsonLines(output: string): Record<string, unknown>[] {
  const trimmed = output.trim();
  if (!trimmed) return [];

  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return parsed.filter(isRecord);
    return isRecord(parsed) ? [parsed] : [];
  } catch {
    return trimmed.split(/\r?\n/).flatMap((line) => {
      try {
        const parsed: unknown = JSON.parse(line);
        return isRecord(parsed) ? [parsed] : [];
      } catch {
        return [];
      }
    });
  }
}

function parseMemoryBytes(value: unknown) {
  if (typeof value !== "string") return null;
  const match = value.trim().match(/^([\d.]+)\s*([kmgt]?i?b)$/i);
  if (!match) return null;

  const unit = match[2].toLowerCase();
  const prefix = unit[0];
  const exponent = prefix === "k" ? 1 : prefix === "m" ? 2 : prefix === "g" ? 3 : prefix === "t" ? 4 : 0;
  const base = unit.includes("i") ? 1024 : 1000;
  return Number(match[1]) * base ** exponent;
}

export function parseComposeStats(output: string) {
  const [stats] = parseJsonLines(output);
  if (!stats) return null;

  const cpu = typeof stats.CPUPerc === "string" ? Number.parseFloat(stats.CPUPerc) : Number.NaN;
  const [memoryUsage, memoryLimit] = typeof stats.MemUsage === "string" ? stats.MemUsage.split("/") : [];
  return {
    cpuPercent: Number.isFinite(cpu) ? cpu : null,
    memoryUsageBytes: parseMemoryBytes(memoryUsage),
    memoryLimitBytes: parseMemoryBytes(memoryLimit),
  };
}

function emptySnapshot(service: ComposeService, state: ComposeServiceState): ComposeServiceSnapshot {
  return {
    service,
    state,
    name: null,
    image: null,
    startedAt: null,
    restartCount: null,
    cpuPercent: null,
    memoryUsageBytes: null,
    memoryLimitBytes: null,
    statsError: null,
  };
}

export async function readComposeServiceSnapshot(service: ComposeService): Promise<ComposeServiceSnapshot> {
  const { stdout } = await runCompose(["ps", "--all", "--format", "json", service], 15_000);
  const [container] = parseJsonLines(stdout);
  if (!container) {
    if (service === "pal") {
      palReadinessCacheKey = null;
      palReadyMarkerDetected = false;
    }
    return emptySnapshot(service, "not_created");
  }

  const rawState = typeof container.State === "string" ? container.State.toLowerCase() : "unknown";
  const state: ComposeServiceState = ["running", "paused"].includes(rawState)
    ? "running"
    : ["created", "restarting"].includes(rawState)
      ? "starting"
      : ["exited", "stopped", "dead"].includes(rawState)
        ? "stopped"
        : "unknown";
  const id = typeof container.ID === "string" ? container.ID : null;
  let inspect: Record<string, unknown> | undefined;

  if (id) {
    try {
      const result = await execFileAsync("docker", ["inspect", id], {
        timeout: 10_000,
        maxBuffer: 1024 * 1024,
        encoding: "utf8",
      });
      inspect = parseJsonLines(result.stdout)[0];
    } catch {
      inspect = undefined;
    }
  }

  const inspectState = isRecord(inspect?.State) ? inspect.State : undefined;
  const inspectConfig = isRecord(inspect?.Config) ? inspect.Config : undefined;
  const startedAt = state === "running" && typeof inspectState?.StartedAt === "string" ? inspectState.StartedAt : null;
  const snapshot: ComposeServiceSnapshot = {
    ...emptySnapshot(service, state),
    name: typeof container.Name === "string" ? container.Name : null,
    image: typeof inspectConfig?.Image === "string" ? inspectConfig.Image : typeof container.Image === "string" ? container.Image : null,
    startedAt,
    restartCount: typeof inspect?.RestartCount === "number" ? inspect.RestartCount : null,
  };

  const containerRunning = state === "running";
  if (service === "pal") {
    if (!containerRunning || !id || !startedAt) {
      palReadinessCacheKey = null;
      palReadyMarkerDetected = false;
      if (containerRunning) snapshot.state = "starting";
    } else {
      const containerId = `${id}:${startedAt}`;
      if (palReadinessCacheKey !== containerId) {
        palReadinessCacheKey = containerId;
        palReadyMarkerDetected = false;
      }
      if (!palReadyMarkerDetected) {
        try {
          const logs = await runCompose(["logs", "--no-log-prefix", "--no-color", "--since", startedAt, "--tail", "500", "pal"], 15_000);
          palReadyMarkerDetected = hasPalworldReadyMarker(logs.stdout);
        } catch {
          palReadyMarkerDetected = false;
        }
      }
      snapshot.state = palReadyMarkerDetected ? "running" : "starting";
    }
  }

  if (containerRunning) {
    try {
      const stats = await runCompose(["stats", "--no-stream", "--format", "json", service], 15_000);
      const parsed = parseComposeStats(stats.stdout);
      if (!parsed) throw new Error("Docker stats の応答が空です");
      Object.assign(snapshot, parsed);
    } catch {
      snapshot.statsError = "Docker stats を取得できませんでした";
    }
  }

  return snapshot;
}

type ComposeExecutor = (args: readonly string[], timeoutMs?: number) => Promise<{ stdout: string; stderr: string }>;

export async function runComposeLifecycle(action: ComposeLifecycleAction, execute: ComposeExecutor = runCompose) {
  if (activeLifecycleOperations.has(composeDirectory)) throw new ComposeOperationInProgressError();

  activeLifecycleOperations.add(composeDirectory);
  try {
    switch (action) {
      case "start":
        await execute(["up", "-d"]);
        break;
      case "stop":
        await execute(["down"]);
        break;
      case "restart":
        await execute(["down"]);
        await execute(["up", "-d"]);
        break;
    }
    return { action, completed: true };
  } finally {
    activeLifecycleOperations.delete(composeDirectory);
  }
}