import { NextResponse } from "next/server";
import { isSameOriginRequest, readApiRole } from "../../../../lib/server/api-auth";
import { readComposeServiceSnapshot } from "../../../../lib/server/compose";
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
    const [overview, settings] = await Promise.all([
      readPalworldOverview(container.state === "running"),
      readSettings(),
    ]);
    const cacheUpdates = {
      ...(overview.info ? {
        version: overview.info.version,
        servername: overview.info.servername,
        description: overview.info.description,
      } : {}),
      ...(overview.metrics ? { days: overview.metrics.days } : {}),
    };
    const dashboardCache = Object.keys(cacheUpdates).length > 0
      ? await updateDashboardCache(cacheUpdates).catch(() => readDashboardCache())
      : await readDashboardCache();
    const autoPauseSetting = settings.categories.find((category) => category.category === "system")?.values.find((setting) => setting.key === "AUTO_PAUSE_ENABLED");
    return NextResponse.json({
      ...overview,
      dashboardCache,
      autoPauseEnabled: autoPauseSetting ? autoPauseSetting.value.toLowerCase() === "true" : null,
      container,
    });
  } catch {
    const paused = await readPalworldOverview(false).then((overview) => overview.paused).catch(() => false);
    return NextResponse.json({
      paused,
      info: null,
      metrics: null,
      errors: {
        info: "Palworld サーバーへ接続できませんでした",
        metrics: "Palworld サーバーへ接続できませんでした",
      },
      dashboardCache: cachedDashboard,
      autoPauseEnabled: null,
      container: {
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