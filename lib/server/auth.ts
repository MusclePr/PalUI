import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { access, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

const serverDir = "/server";
const credentialsFile = ".passwd";
const cookieName = "palui_session";
const sessionMaxAge = 60 * 60 * 8;

export type AuthRole = "admin" | "operator";

async function getCredentialsPath() {
  if (process.env.PALUI_SERVER_DIR) return join(process.env.PALUI_SERVER_DIR, credentialsFile);
  try { await access(serverDir); return join(serverDir, credentialsFile); } catch { return join(process.cwd(), "palui", "server", credentialsFile); }
}

function readEnv(content: string) {
  return content.split("\n").reduce<Record<string, string>>((result, line) => {
    const match = line.match(/^\s*([A-Z0-9_]+)=(.*)$/);
    if (match) result[match[1]] = match[2];
    return result;
  }, {});
}

function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  const derived = scryptSync(password, salt, 64).toString("hex");
  return `scrypt$${salt}$${derived}`;
}

function verifyPassword(password: string, encoded: string) {
  const [, salt, expected] = encoded.split("$");
  if (!salt || !expected) return false;
  const actual = scryptSync(password, salt, 64);
  const expectedBuffer = Buffer.from(expected, "hex");
  return actual.length === expectedBuffer.length && timingSafeEqual(actual, expectedBuffer);
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

export async function getAuthState() {
  const values = readEnv(await readFile(await getCredentialsPath(), "utf8").catch(() => ""));
  return { configured: Boolean(values.ADMIN_PASSWORD_HASH && values.OP_PASSWORD_HASH), values };
}

async function writeCredentials(adminPassword: string, operatorPassword: string) {
  const path = await getCredentialsPath();
  const content = await readFile(path, "utf8").catch(() => "");
  const replacements: Record<string, string> = { ADMIN_PASSWORD_HASH: hashPassword(adminPassword), OP_PASSWORD_HASH: hashPassword(operatorPassword) };
  const lines = content.split("\n");
  for (const key of Object.keys(replacements)) {
    const index = lines.findIndex((line) => line.startsWith(`${key}=`));
    if (index >= 0) lines[index] = `${key}=${replacements[key]}`;
    else lines.push(`${key}=${replacements[key]}`);
  }
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, lines.join("\n"), { mode: 0o600 });
  await rename(temporary, path);
}

export async function setupPasswords(adminPassword: string, operatorPassword: string) {
  if (adminPassword.length < 8 || operatorPassword.length < 8) throw new Error("パスワードは8文字以上で設定してください");
  const state = await getAuthState();
  if (state.configured) throw new Error("パスワードは既に設定されています");
  await writeCredentials(adminPassword, operatorPassword);
}

export async function authenticate(account: string, password: string) {
  const state = await getAuthState();
  const role = account === "admin" ? "admin" : account === "operator" ? "operator" : null;
  const hash = role === "admin" ? state.values.ADMIN_PASSWORD_HASH : role === "operator" ? state.values.OP_PASSWORD_HASH : "";
  return role && hash && verifyPassword(password, hash) ? { role, cookie: signSession(role) } : null;
}

export const authCookie = { name: cookieName, maxAge: sessionMaxAge };