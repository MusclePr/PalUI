import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { authCookie, readSession } from "../../../lib/server/auth";
import { addRegisteredPlayer, deleteRegisteredPlayer, detectUnregisteredPlayers, PlayerStoreError, readPlayers, registerDetectedPlayers, updateWhitelist } from "../../../lib/server/palworld";

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
  try {
    const data = await readPlayers();
    const etag = `"${createHash("sha256").update(JSON.stringify(data)).digest("hex")}"`;
    const headers = { ETag: etag, "Cache-Control": "private, no-cache", Vary: "Cookie" };
    if (request.headers.get("if-none-match")?.split(",").map((value) => value.trim()).includes(etag)) {
      return new Response(null, { status: 304, headers });
    }
    return NextResponse.json(data, { headers });
  } catch (error) {
    console.error("Player data could not be read:", error instanceof Error ? error.message : "Unknown error");
    return NextResponse.json({ error: "プレイヤー情報を読み込めませんでした" }, { status: 503 });
  }
}

export async function POST(request: Request) {
  if (!readRole(request)) return unauthorized();
  try {
    const body = await request.json() as { action?: unknown; userId?: unknown; displayName?: unknown; enabled?: unknown; role?: unknown; players?: unknown };
    if (body.action === "detect") {
      return NextResponse.json({ detected: await detectUnregisteredPlayers() });
    }
    if (body.action === "register-detected" && Array.isArray(body.players) && body.players.length > 0 && body.players.length <= 50) {
      const entries = body.players.map((item) => item as { userId?: unknown; displayName?: unknown });
      if (!entries.every((item) => typeof item.userId === "string" && typeof item.displayName === "string")) {
        return NextResponse.json({ error: "不正なプレイヤー操作です" }, { status: 400 });
      }
      return NextResponse.json(await registerDetectedPlayers(entries.map((item) => ({ userId: item.userId as string, displayName: item.displayName as string }))));
    }
    if ((body.action === "whitelist" || body.action === undefined) && typeof body.userId === "string" && typeof body.enabled === "boolean") {
      await updateWhitelist(body.userId, body.enabled);
      return NextResponse.json(await readPlayers());
    }
    if (body.action === "add" && typeof body.userId === "string" && typeof body.displayName === "string" && typeof body.enabled === "boolean") {
      return NextResponse.json(await addRegisteredPlayer({ userId: body.userId, displayName: body.displayName, enabled: body.enabled, role: typeof body.role === "string" ? body.role : undefined }));
    }
    if (body.action === "delete" && typeof body.userId === "string") {
      return NextResponse.json(await deleteRegisteredPlayer(body.userId));
    }
    return NextResponse.json({ error: "不正なプレイヤー操作です" }, { status: 400 });
  } catch (error) {
    if (error instanceof PlayerStoreError) return NextResponse.json({ error: error.message }, { status: error.status });
    console.error("Player data could not be updated:", error instanceof Error ? error.message : "Unknown error");
    return NextResponse.json({ error: "プレイヤー情報を更新できませんでした" }, { status: 503 });
  }
}