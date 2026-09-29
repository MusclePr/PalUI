import { NextResponse } from "next/server";
import { isSameOriginRequest, readApiRole } from "../../../../lib/server/api-auth";
import { ComposeOperationInProgressError, runComposeLifecycle, type ComposeLifecycleAction } from "../../../../lib/server/compose";

export const runtime = "nodejs";

const lifecycleActions = new Set<ComposeLifecycleAction>(["start", "stop", "restart"]);

export async function POST(request: Request) {
  if (!readApiRole(request)) {
    return NextResponse.json({ error: "ログインが必要です" }, { status: 401 });
  }
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "不正な送信元です" }, { status: 403 });
  }

  let body: { action?: unknown };
  try {
    body = await request.json() as { action?: unknown };
  } catch {
    return NextResponse.json({ error: "不正なJSONです" }, { status: 400 });
  }

  if (typeof body.action !== "string" || !lifecycleActions.has(body.action as ComposeLifecycleAction)) {
    return NextResponse.json({ error: "不正なライフサイクル操作です" }, { status: 400 });
  }

  try {
    return NextResponse.json(await runComposeLifecycle(body.action as ComposeLifecycleAction));
  } catch (error) {
    if (error instanceof ComposeOperationInProgressError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    return NextResponse.json({ error: "Composeのライフサイクル操作に失敗しました" }, { status: 503 });
  }
}