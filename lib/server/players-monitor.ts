import { readCachedProxyPlayers, readPlayerMonitorContainer } from "./compose";
import { synchronizePlayers, type PalworldPlayer } from "./palworld";
import { parseProxyPlayers, readPlayersCache, withPlayersLock, writePlayersCache } from "./players-cache";

type MonitorDependencies = {
  readContainer: typeof readPlayerMonitorContainer;
  fetchPlayers: () => Promise<unknown | null>;
  synchronize: typeof synchronizePlayers;
  reportError: (error: unknown) => Promise<void>;
};

async function reportError(error: unknown) {
  console.error("Player monitoring failed:", error instanceof Error ? error.message : "Unknown error");
  await withPlayersLock(async () => {
    const current = await readPlayersCache();
    await writePlayersCache({ ...current, error: "プレイヤー情報の監視に失敗しました。最後に取得した情報を表示しています" });
  });
}

export function createPlayersMonitor(dependencies: MonitorDependencies = {
  readContainer: readPlayerMonitorContainer,
  fetchPlayers: readCachedProxyPlayers,
  synchronize: synchronizePlayers,
  reportError,
}) {
  let busy = false;
  let previous: PalworldPlayer[] | null = null;
  let containerId: string | null = null;
  let pending: { players: PalworldPlayer[]; previous: PalworldPlayer[] | null; timestamp: string } | null = null;
  return async function tick() {
    if (busy) return;
    busy = true;
    try {
      const container = await dependencies.readContainer();
      if (container.state !== "running") {
        previous = null;
        pending = null;
        containerId = null;
        await dependencies.synchronize([], null, new Date().toISOString());
        return;
      }
      if (containerId !== container.id) {
        previous = null;
        pending = null;
        containerId = container.id;
      }
      // Retry the same observation after a partial save, preserving its logout timestamp.
      if (pending) {
        await dependencies.synchronize(pending.players, pending.previous, pending.timestamp);
        previous = pending.players;
        pending = null;
      }
      const response = await dependencies.fetchPlayers();
      const players = response === null ? null : parseProxyPlayers(response);
      const timestamp = new Date().toISOString();
      if (players !== null) pending = { players, previous, timestamp };
      await dependencies.synchronize(players, previous, timestamp);
      if (players !== null) {
        previous = players;
        pending = null;
      }
    } catch (error) {
      try {
        await dependencies.reportError(error);
      } catch (reportingError) {
        console.error("Player monitoring error could not be saved:", reportingError instanceof Error ? reportingError.message : "Unknown error");
      }
    } finally {
      busy = false;
    }
  };
}

const globalMonitor = globalThis as typeof globalThis & { paluiPlayersMonitor?: ReturnType<typeof setInterval> };

export function startPlayersMonitor(tick = createPlayersMonitor()) {
  if (globalMonitor.paluiPlayersMonitor) return;
  globalMonitor.paluiPlayersMonitor = setInterval(() => { void tick(); }, 5_000);
  globalMonitor.paluiPlayersMonitor.unref();
  void tick();
}
