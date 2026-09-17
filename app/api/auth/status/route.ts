import { NextResponse } from "next/server";
import { getAuthState, readSession } from "../../../../lib/server/auth";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const session = request.headers.get("cookie")?.match(/(?:^|; )palui_session=([^;]+)/)?.[1];
  return NextResponse.json({ configured: (await getAuthState()).configured, role: readSession(session) });
}