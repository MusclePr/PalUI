import { NextResponse } from "next/server";
import { createBackup, deleteBackup, listBackups, readStorageUsage, restoreBackup } from "../../../lib/server/palworld";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json({ backups: await listBackups(), storage: await readStorageUsage() });
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as { action?: unknown; name?: unknown; stopConfirmed?: unknown };
    if (body.action === "create") return NextResponse.json(await createBackup());
    if ((body.action === "restore" || body.action === "delete") && typeof body.name === "string") {
      if (!/^[a-zA-Z0-9._-]+\.tar\.gz$/.test(body.name)) {
        return NextResponse.json({ error: "不正なバックアップ名です" }, { status: 400 });
      }
      if (body.action === "delete") return NextResponse.json(await deleteBackup(body.name));
      if (body.stopConfirmed === true) return NextResponse.json(await restoreBackup(body.name));
    }
    return NextResponse.json({ error: "不正なバックアップ操作です" }, { status: 400 });
  } catch {
    return NextResponse.json({ error: "バックアップ操作に失敗しました" }, { status: 503 });
  }
}