import { NextResponse } from "next/server";
import { authCookie, authenticate, isSameOriginRequest } from "../../../../lib/server/auth";

export const runtime = "nodejs";

function redirectUrl(request: Request, pathname: string) {
  const basePath = process.env.NEXT_PUBLIC_BASE_PATH || "/palui";
  return new URL(`${basePath}${pathname}`, request.url);
}

function invalidCredentialsRedirect(request: Request) {
  const url = redirectUrl(request, "/login");
  url.searchParams.set("authNotice", "invalid-credentials");
  return NextResponse.redirect(url, { status: 303 });
}

async function readLoginBody(request: Request) {
  if (request.headers.get("content-type")?.includes("application/json")) return await request.json() as { account?: unknown; username?: unknown; password?: unknown };
  const form = await request.formData();
  return { username: form.get("username"), account: form.get("account"), password: form.get("password") };
}

export async function POST(request: Request) {
  const wantsJson = request.headers.get("content-type")?.includes("application/json");
  if (!wantsJson && !isSameOriginRequest(request)) return NextResponse.json({ error: "ログイン要求を確認できませんでした" }, { status: 403 });
  const body = await readLoginBody(request);
  const account = typeof body.username === "string" ? body.username : body.account;
  if (typeof account !== "string" || typeof body.password !== "string") {
    if (!wantsJson) return invalidCredentialsRedirect(request);
    return NextResponse.json({ error: "アカウントとパスワードを入力してください" }, { status: 400 });
  }
  const result = await authenticate(account, body.password);
  if (!result) {
    if (!wantsJson) return invalidCredentialsRedirect(request);
    return NextResponse.json({ error: "アカウントまたはパスワードが正しくありません" }, { status: 401 });
  }
  const response = wantsJson ? NextResponse.json({ role: result.role }) : NextResponse.redirect(redirectUrl(request, "/dashboard"), { status: 303 });
  response.cookies.set(authCookie.name, result.cookie, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", maxAge: authCookie.maxAge, path: "/" });
  return response;
}