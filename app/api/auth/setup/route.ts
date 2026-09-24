import { NextResponse } from "next/server";
import { setupPasswords } from "../../../../lib/server/auth";

export const runtime = "nodejs";

function redirectUrl(request: Request, pathname: string) {
  const basePath = process.env.NEXT_PUBLIC_BASE_PATH || "/palui";
  return new URL(`${basePath}${pathname}`, request.url);
}

function setupErrorResponse(request: Request, error: unknown, wantsJson: boolean) {
  const message = error instanceof Error ? error.message : "初期設定に失敗しました";
  const alreadyConfigured = message === "パスワードは既に設定されています";
  const publicMessage = alreadyConfigured ? "パスワードは設定済みです。ログインしてください。" : message;
  if (wantsJson) return NextResponse.json({ error: publicMessage, code: alreadyConfigured ? "already-configured" : "setup-failed" }, { status: 409 });
  const url = redirectUrl(request, "/login");
  if (alreadyConfigured) url.searchParams.set("authNotice", "already-configured");
  return NextResponse.redirect(url, { status: 303 });
}

async function readSetupBody(request: Request) {
  if (request.headers.get("content-type")?.includes("application/json")) return await request.json() as { adminPassword?: unknown; adminPasswordConfirmation?: unknown; operatorPassword?: unknown; operatorPasswordConfirmation?: unknown };
  const form = await request.formData();
  return { adminPassword: form.get("adminPassword"), adminPasswordConfirmation: form.get("adminPasswordConfirmation"), operatorPassword: form.get("operatorPassword"), operatorPasswordConfirmation: form.get("operatorPasswordConfirmation") };
}

export async function POST(request: Request) {
  const wantsJson = request.headers.get("content-type")?.includes("application/json");
  try {
    const body = await readSetupBody(request);
    if (typeof body.adminPassword !== "string" || typeof body.adminPasswordConfirmation !== "string" || typeof body.operatorPassword !== "string" || typeof body.operatorPasswordConfirmation !== "string") return NextResponse.json({ error: "4つの入力欄をすべて入力してください" }, { status: 400 });
    if (body.adminPassword !== body.adminPasswordConfirmation || body.operatorPassword !== body.operatorPasswordConfirmation) return NextResponse.json({ error: "確認用パスワードが一致していません" }, { status: 400 });
    await setupPasswords(body.adminPassword, body.operatorPassword);
    if (!wantsJson) return NextResponse.redirect(redirectUrl(request, "/login"), { status: 303 });
    return NextResponse.json({ configured: true });
  } catch (error) { return setupErrorResponse(request, error, Boolean(wantsJson)); }
}