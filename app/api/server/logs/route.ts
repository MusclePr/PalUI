import { NextResponse } from "next/server";
import { readApiRole } from "../../../../lib/server/api-auth";
import { composeCommand, isComposeService } from "../../../../lib/server/compose";
import { createLogStreamResponse } from "../../../../lib/server/log-stream";

export const runtime = "nodejs";

export async function GET(request: Request) {
  if (!readApiRole(request)) {
    return NextResponse.json({ error: "ログインが必要です" }, { status: 401 });
  }

  const service = new URL(request.url).searchParams.get("service");
  if (!isComposeService(service)) {
    return NextResponse.json({ error: "対象サービスが不正です" }, { status: 400 });
  }

  const command = composeCommand(["logs", "--follow", "--tail", "100", "--timestamps", "--no-color", "--no-log-prefix", service]);
  return createLogStreamResponse(request, command);
}