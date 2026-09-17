import { NextResponse } from "next/server";
import { authCookie, authenticate } from "../../../../lib/server/auth";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const body = await request.json() as { account?: unknown; password?: unknown };
  if (typeof body.account !== "string" || typeof body.password !== "string") return NextResponse.json({ error: "アカウントとパスワードを入力してください" }, { status: 400 });
  const result = await authenticate(body.account, body.password);
  if (!result) return NextResponse.json({ error: "アカウントまたはパスワードが正しくありません" }, { status: 401 });
  const response = NextResponse.json({ role: result.role });
  response.cookies.set(authCookie.name, result.cookie, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", maxAge: authCookie.maxAge, path: "/" });
  return response;
}