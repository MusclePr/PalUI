import { NextResponse } from "next/server";
import { isSameOriginRequest, readApiRole } from "../../../../lib/server/api-auth";
import { readComposeServiceSnapshot, readPalworldStatus } from "../../../../lib/server/compose";
import { readDashboardCache, updateDashboardCache } from "../../../../lib/server/dashboard-cache";
import { readPalworldOverview, readSettings, setAutoPause } from "../../../../lib/server/palworld";

export const runtime = "nodejs";

function unauthorized() {
  return NextResponse.json({ error: "ログインが必要です" }, { status: 401 });
}

export async function GET(request: Request) {
  if (!readApiRole(request)) return unauthorized();

  const cachedDashboard = await readDashboardCache();
  try {
    const container = await readComposeServiceSnapshot("pal");
    const serverStatusRequest = container.state === "running" || container.state === "starting" || container.state === "unknown"
      ? readPalworldStatus().catch((error) => {
          console.warn("Palworldの状態ファイルを読み込めませんでした", error);
          return null;
        })
      : Promise.resolve(null);
    const [overview, settings, serverStatus] = await Promise.all([
      readPalworldOverview(container.state === "running"),
      readSettings(),
      serverStatusRequest,
    ]);
    const autoPauseSetting = settings.categories.find((category) => category.category === "system")?.values.find((setting) => setting.key === "AUTO_PAUSE_ENABLED");
    const autoPauseEnabled = autoPauseSetting ? autoPauseSetting.value.toLowerCase() === "true" : null;
    const observedAt = new Date().toISOString();
    const cacheUpdates = {
      ...(overview.info ? {
        version: overview.info.version,
        servername: overview.info.servername,
        description: overview.info.description,
      } : {}),
      ...(overview.metrics ? { days: overview.metrics.days } : {}),
      snapshot: {
        container: { ...container, service: "pal" as const },
        serverStatus,
        paused: overview.paused,
        autoPauseEnabled,
        metrics: overview.metrics,
        lastRefreshAt: observedAt,
        lastStatsAt: container.cpuPercent !== null || container.memoryUsageBytes !== null ? observedAt : null,
        lastMetricsAt: overview.metrics ? observedAt : null,
      },
    };
    const dashboardCache = await updateDashboardCache(cacheUpdates).catch((error) => {
      console.warn("ダッシュボードのキャッシュを更新できませんでした", error);
      return readDashboardCache();
    });
    return NextResponse.json({
      ...overview,
      dashboardCache,
      autoPauseEnabled: autoPauseEnabled ?? dashboardCache.snapshot?.autoPauseEnabled ?? null,
      container: dashboardCache.snapshot?.container ?? container,
      serverStatus: serverStatus ?? (container.state === "unknown" ? dashboardCache.snapshot?.serverStatus : null) ?? null,
      metrics: overview.metrics ?? dashboardCache.snapshot?.metrics ?? null,
      lastRefreshAt: dashboardCache.snapshot?.lastRefreshAt ?? observedAt,
      lastStatsAt: dashboardCache.snapshot?.lastStatsAt ?? null,
      lastMetricsAt: dashboardCache.snapshot?.lastMetricsAt ?? null,
    });
  } catch {
    const paused = await readPalworldOverview(false).then((overview) => overview.paused).catch(() => false);
    const snapshot = cachedDashboard.snapshot;
    return NextResponse.json({
      paused,
      info: null,
      metrics: snapshot?.metrics ?? null,
      serverStatus: snapshot?.serverStatus ?? null,
      errors: {
        info: "Palworld サーバーへ接続できませんでした",
        metrics: "Palworld サーバーへ接続できませんでした",
      },
      dashboardCache: cachedDashboard,
      autoPauseEnabled: snapshot?.autoPauseEnabled ?? null,
      lastRefreshAt: snapshot?.lastRefreshAt ?? cachedDashboard.updatedAt,
      lastStatsAt: snapshot?.lastStatsAt ?? null,
      lastMetricsAt: snapshot?.lastMetricsAt ?? null,
      container: snapshot?.container ?? {
        service: "pal",
        state: "unknown",
        name: null,
        image: null,
        startedAt: null,
        restartCount: null,
        cpuPercent: null,
        memoryUsageBytes: null,
        memoryLimitBytes: null,
        statsError: "Docker状態を取得できませんでした",
      },
    });
  }
}

export async function POST(request: Request) {
  if (!readApiRole(request)) return unauthorized();
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "不正な送信元です" }, { status: 403 });
  }

  let body: { autoPauseEnabled?: unknown };
  try {
    body = await request.json() as { autoPauseEnabled?: unknown };
  } catch {
    return NextResponse.json({ error: "不正なJSONです" }, { status: 400 });
  }
  if (typeof body.autoPauseEnabled !== "boolean") {
    return NextResponse.json({ error: "autoPauseEnabled は boolean で指定してください" }, { status: 400 });
  }

  try {
    return NextResponse.json(await setAutoPause(body.autoPauseEnabled));
  } catch {
    return NextResponse.json({ error: "AUTO PAUSE機能を変更できませんでした" }, { status: 503 });
  }
}