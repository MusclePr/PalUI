import { NextResponse } from "next/server";
import { authCookie, readSession } from "../../../lib/server/auth";
import { addRegisteredPlayer, deleteRegisteredPlayer, PlayerStoreError, readPlayers, updateWhitelist } from "../../../lib/server/palworld";

export const runtime = "nodejs";

function readRole(request: Request) {
  const escapedCookieName = authCookie.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const session = request.headers.get("cookie")?.match(new RegExp(`(?:^|; )${escapedCookieName}=([^;]+)`))?.[1];
  return readSession(session);
}

function unauthorized() {
  return NextResponse.json({ error: "ログインが必要です" }, { status: 401 });
}

export async function GET(request: Request) {
  if (!readRole(request)) return unauthorized();
  return NextResponse.json(await readPlayers());
}

export async function POST(request: Request) {
  if (!readRole(request)) return unauthorized();
  try {
    const body = await request.json() as { action?: unknown; playerId?: unknown; displayName?: unknown; enabled?: unknown; role?: unknown };
    if ((body.action === "whitelist" || body.action === undefined) && typeof body.playerId === "string" && typeof body.enabled === "boolean") {
      await updateWhitelist(body.playerId, body.enabled);
      return NextResponse.json(await readPlayers());
    }
    if (body.action === "add" && typeof body.playerId === "string" && typeof body.displayName === "string" && typeof body.enabled === "boolean") {
      return NextResponse.json(await addRegisteredPlayer({ playerId: body.playerId, displayName: body.displayName, enabled: body.enabled, role: typeof body.role === "string" ? body.role : undefined }));
    }
    if (body.action === "delete" && typeof body.playerId === "string") {
      return NextResponse.json(await deleteRegisteredPlayer(body.playerId));
    }
    return NextResponse.json({ error: "不正なプレイヤー操作です" }, { status: 400 });
  } catch (error) {
    if (error instanceof PlayerStoreError) return NextResponse.json({ error: error.message }, { status: error.status });
    return NextResponse.json({ error: "プレイヤー情報を更新できませんでした" }, { status: 503 });
  }
}