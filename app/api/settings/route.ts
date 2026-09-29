import { isSameOriginRequest, readApiRole } from "../../../lib/server/api-auth";
import { readSettings, saveSettings } from "../../../lib/server/palworld";

export const runtime = "nodejs";

function visibleSettings(settings: Awaited<ReturnType<typeof readSettings>>, role: "admin" | "operator") {
  const categories = role === "admin" ? settings.categories : settings.categories.filter((category) => category.category !== "compose");
  return {
    ...settings,
    categories,
    overridden: categories.reduce((count, category) => count + category.values.filter((setting) => setting.overridden).length, 0),
  };
}

export async function GET(request: Request) {
  const role = readApiRole(request);
  if (!role) return Response.json({ error: "ログインが必要です" }, { status: 401 });
  return Response.json(visibleSettings(await readSettings(), role));
}

export async function POST(request: Request) {
  const role = readApiRole(request);
  if (!role) return Response.json({ error: "ログインが必要です" }, { status: 401 });
  if (!isSameOriginRequest(request)) return Response.json({ error: "不正な送信元です" }, { status: 403 });

  try {
    const body = await request.json() as { values?: unknown; expectedHash?: unknown };
    if (!body.values || typeof body.values !== "object" || typeof body.expectedHash !== "string") return Response.json({ error: "設定値とハッシュが必要です" }, { status: 400 });
    if (role === "operator") {
      const settings = await readSettings();
      const composeKeys = new Set(settings.categories.find((category) => category.category === "compose")?.values.map((setting) => setting.key) ?? []);
      if (Object.keys(body.values).some((key) => composeKeys.has(key))) return Response.json({ error: "運用者は.env設定を変更できません" }, { status: 403 });
    }
    const savedSettings = await saveSettings(body.values as Record<string, string>, body.expectedHash);
    return Response.json(visibleSettings(savedSettings, role));
  } catch (error) {
    const message = error instanceof Error && error.message.includes("外部変更") ? error.message : "設定を保存できませんでした";
    return Response.json({ error: message }, { status: message.includes("外部変更") ? 409 : 503 });
  }
}