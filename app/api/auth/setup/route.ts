import { NextResponse } from "next/server";
import { setupPasswords } from "../../../../lib/server/auth";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body = await request.json() as { adminPassword?: unknown; adminPasswordConfirmation?: unknown; operatorPassword?: unknown; operatorPasswordConfirmation?: unknown };
    if (typeof body.adminPassword !== "string" || typeof body.adminPasswordConfirmation !== "string" || typeof body.operatorPassword !== "string" || typeof body.operatorPasswordConfirmation !== "string") return NextResponse.json({ error: "4つの入力欄をすべて入力してください" }, { status: 400 });
    if (body.adminPassword !== body.adminPasswordConfirmation || body.operatorPassword !== body.operatorPasswordConfirmation) return NextResponse.json({ error: "確認用パスワードが一致していません" }, { status: 400 });
    await setupPasswords(body.adminPassword, body.operatorPassword);
    return NextResponse.json({ configured: true });
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "初期設定に失敗しました" }, { status: 409 }); }
}