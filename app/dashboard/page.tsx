import { connection } from "next/server";
import { readPalworldStatus } from "../../lib/server/compose";
import { readDashboardCache } from "../../lib/server/dashboard-cache";
import DashboardClient from "./DashboardClient";

export default async function DashboardPage() {
  await connection();
  const dashboardCache = await readDashboardCache();
  const containerState = dashboardCache.snapshot?.container.state;
  const canReadServerStatus = containerState === "running" || containerState === "starting" || containerState === "unknown";
  const serverStatus = canReadServerStatus
    ? await readPalworldStatus().catch((error) => {
      console.error("ダッシュボードの初期状態を取得できませんでした", error);
      return null;
    })
    : null;

  return <DashboardClient
    initialDashboardCache={dashboardCache}
    initialServerStatus={serverStatus ?? (canReadServerStatus ? dashboardCache.snapshot?.serverStatus : null) ?? null}
    initialSnapshot={dashboardCache.snapshot}
  />;
}
