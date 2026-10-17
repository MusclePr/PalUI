import { createHmac, timingSafeEqual } from "node:crypto";
import { readSettings, saveSettings } from "./palworld";

const cookieName = "palui_session";
const sessionMaxAge = 60 * 60 * 8;

export type AuthRole = "admin" | "operator";

async function readAuthSettings() {
  const settings = await readSettings();
  const compose = settings.categories.find((category) => category.category === "compose");
  const adminPassword = compose?.values.find(({ key }) => key === "ADMIN_PASSWORD");
  const operatorPassword = compose?.values.find(({ key }) => key === "OP_PASSWORD");
  return {
    settings,
    values: {
      ADMIN_PASSWORD: adminPassword?.value ?? "",
      OP_PASSWORD: operatorPassword?.value ?? "",
    },
    configured: Boolean(adminPassword?.overridden && adminPassword.value && operatorPassword?.overridden && operatorPassword.value),
  };
}

function verifyPassword(password: string, expected: string) {
  const actualBuffer = Buffer.from(password);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

function sessionSecret() {
  return process.env.AUTH_COOKIE_SECRET || "palui-development-cookie-secret-change-me";
}

function signSession(role: AuthRole) {
  const payload = Buffer.from(JSON.stringify({ role, exp: Math.floor(Date.now() / 1000) + sessionMaxAge })).toString("base64url");
  const signature = createHmac("sha256", sessionSecret()).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

export function readSession(cookie: string | undefined): AuthRole | null {
  if (!cookie) return null;
  const [payload, signature] = cookie.split(".");
  if (!payload || !signature) return null;
  const expected = createHmac("sha256", sessionSecret()).update(payload).digest("base64url");
  if (signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  try {
    const value = JSON.parse(Buffer.from(payload, "base64url").toString()) as { role?: AuthRole; exp?: number };
    return value.exp && value.exp > Math.floor(Date.now() / 1000) && (value.role === "admin" || value.role === "operator") ? value.role : null;
  } catch { return null; }
}

export function isSameOriginRequest(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin) return false;

  try {
    const requestUrl = new URL(request.url);
    const forwardedHost = request.headers.get("x-forwarded-host")?.split(",")[0].trim();
    const forwardedProto = request.headers.get("x-forwarded-proto")?.split(",")[0].trim();
    const host = forwardedHost || request.headers.get("host") || requestUrl.host;
    const protocol = (forwardedProto || requestUrl.protocol.slice(0, -1)).toLowerCase();
    if (protocol !== "http" && protocol !== "https") return false;
    return new URL(origin).origin === new URL(`${protocol}://${host}`).origin;
  } catch {
    return false;
  }
}

export async function getAuthState() {
  const { values, configured } = await readAuthSettings();
  return { configured, values };
}

export async function setupPasswords(adminPassword: string, operatorPassword: string) {
  if (!adminPassword || !operatorPassword) throw new Error("両方のパスワードを入力してください");
  const { settings, configured } = await readAuthSettings();
  if (configured) throw new Error("パスワードは既に設定されています");
  await saveSettings({ ADMIN_PASSWORD: adminPassword, OP_PASSWORD: operatorPassword }, settings.hash);
}

export async function authenticate(account: string, password: string) {
  const state = await getAuthState();
  const role = account === "admin" ? "admin" : account === "operator" ? "operator" : null;
  const expected = role === "admin" ? state.values.ADMIN_PASSWORD : role === "operator" ? state.values.OP_PASSWORD : "";
  return state.configured && role && expected && verifyPassword(password, expected) ? { role, cookie: signSession(role) } : null;
}

export const authCookie = { name: cookieName, maxAge: sessionMaxAge };