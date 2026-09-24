import { NextResponse } from "next/server";
import { authCookie, authenticate } from "../../../../lib/server/auth";

export const runtime = "nodejs";

function redirectUrl(request: Request, pathname: string) {
  const basePath = process.env.NEXT_PUBLIC_BASE_PATH || "/palui";
  return new URL(`${basePath}${pathname}`, request.url);
}

async function readLoginBody(request: Request) {
  if (request.headers.get("content-type")?.includes("application/json")) return await request.json() as { account?: unknown; password?: unknown };
  const form = await request.formData();
  return { account: form.get("account"), password: form.get("password") };
}

export async function POST(request: Request) {
  const wantsJson = request.headers.get("content-type")?.includes("application/json");
  const body = await readLoginBody(request);
  if (typeof body.account !== "string" || typeof body.password !== "string") return NextResponse.json({ error: "アカウントとパスワードを入力してください" }, { status: 400 });
  const result = await authenticate(body.account, body.password);
  if (!result) return NextResponse.json({ error: "アカウントまたはパスワードが正しくありません" }, { status: 401 });
  const response = wantsJson ? NextResponse.json({ role: result.role }) : NextResponse.redirect(redirectUrl(request, "/dashboard"), { status: 303 });
  response.cookies.set(authCookie.name, result.cookie, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", maxAge: authCookie.maxAge, path: "/" });
  return response;
}