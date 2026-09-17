import { NextResponse } from "next/server";
import { readSettings, saveSettings } from "../../../lib/server/palworld";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json(await readSettings());
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as { values?: unknown; expectedHash?: unknown };
    if (!body.values || typeof body.values !== "object" || typeof body.expectedHash !== "string") return NextResponse.json({ error: "設定値とハッシュが必要です" }, { status: 400 });
    return NextResponse.json(await saveSettings(body.values as Record<string, string>, body.expectedHash));
  } catch (error) {
    const message = error instanceof Error && error.message.includes("外部変更") ? error.message : "設定を保存できませんでした";
    return NextResponse.json({ error: message }, { status: message.includes("外部変更") ? 409 : 503 });
  }
}