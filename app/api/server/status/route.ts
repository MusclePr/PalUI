import { NextResponse } from "next/server";
import { readApiRole } from "../../../../lib/server/api-auth";
import { isPalworldPaused, readPalworldStatus } from "../../../../lib/server/compose";

export const runtime = "nodejs";

export async function GET(request: Request) {
  if (!readApiRole(request)) {
    return NextResponse.json({ error: "ログインが必要です" }, { status: 401 });
  }

  try {
    const [serverStatus, paused] = await Promise.all([readPalworldStatus(), isPalworldPaused()]);
    return NextResponse.json(
      { serverStatus, paused },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    console.error("サーバー状態を読み込めませんでした", error);
    return NextResponse.json({ error: "サーバー状態を取得できませんでした" }, { status: 503 });
  }
}