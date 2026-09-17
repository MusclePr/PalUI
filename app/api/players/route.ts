import { NextResponse } from "next/server";
import { readPlayers, updateWhitelist } from "../../../lib/server/palworld";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json(await readPlayers());
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as { playerId?: unknown; enabled?: unknown };
    if (typeof body.playerId !== "string" || typeof body.enabled !== "boolean") {
      return NextResponse.json({ error: "playerId と enabled を指定してください" }, { status: 400 });
    }
    return NextResponse.json(await updateWhitelist(body.playerId, body.enabled));
  } catch {
    return NextResponse.json({ error: "ホワイトリストを更新できませんでした" }, { status: 503 });
  }
}