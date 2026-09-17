import { NextResponse } from "next/server";
import { readPalworldOverview, setAutoPause } from "../../../../lib/server/palworld";

export const runtime = "nodejs";

export async function GET() {
  try {
    return NextResponse.json(await readPalworldOverview());
  } catch {
    return NextResponse.json({ error: "Palworld サーバーへ接続できませんでした" }, { status: 503 });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as { autoPauseEnabled?: unknown };
    if (typeof body.autoPauseEnabled !== "boolean") {
      return NextResponse.json({ error: "autoPauseEnabled は boolean で指定してください" }, { status: 400 });
    }
    return NextResponse.json(await setAutoPause(body.autoPauseEnabled));
  } catch {
    return NextResponse.json({ error: "AUTO PAUSE機能を変更できませんでした" }, { status: 503 });
  }
}