import { connection } from "next/server";
import { readPalworldStatus } from "../../lib/server/compose";
import { readDashboardCache } from "../../lib/server/dashboard-cache";
import DashboardClient from "./DashboardClient";

export default async function DashboardPage() {
  await connection();
  const [dashboardCache, serverStatus] = await Promise.all([
    readDashboardCache(),
    readPalworldStatus().catch((error) => {
      console.error("ダッシュボードの初期状態を取得できませんでした", error);
      return null;
    }),
  ]);

  return <DashboardClient
    initialDashboardCache={dashboardCache}
    initialServerStatus={serverStatus ?? dashboardCache.snapshot?.serverStatus ?? null}
    initialSnapshot={dashboardCache.snapshot}
  />;
}
