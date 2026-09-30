import { randomUUID } from "node:crypto";
import { isSameOriginRequest, readApiRole } from "../../../lib/server/api-auth";
import { ComposeOperationInProgressError } from "../../../lib/server/compose";
import { BackupError, createBackup, deleteBackup, listBackups, readStorageUsage, restoreBackup } from "../../../lib/server/palworld";

export const runtime = "nodejs";

type RestoreOperation = {
  createdAt: number;
  status: "running" | "completed" | "warning" | "failed";
  logs: string[];
  result?: Awaited<ReturnType<typeof restoreBackup>>;
  error?: string;
};

const restoreOperations = new Map<string, RestoreOperation>();

function appendRestoreLog(operation: RestoreOperation, message: string) {
  operation.logs.push(`${new Date().toISOString()} ${message.slice(-8000)}`);
  if (operation.logs.length > 200) operation.logs.splice(0, operation.logs.length - 200);
}

export async function GET(request: Request) {
  if (!readApiRole(request)) {
    return Response.json({ error: "ログインが必要です" }, { status: 401 });
  }

  const operationId = new URL(request.url).searchParams.get("operationId");
  if (operationId) {
    const operation = restoreOperations.get(operationId);
    if (!operation) return Response.json({ error: "復元操作が見つかりません" }, { status: 404 });
    return Response.json(operation, { headers: { "Cache-Control": "no-store" } });
  }

  try {
    return Response.json({ backups: await listBackups(), storage: await readStorageUsage() }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "バックアップ一覧を取得できませんでした" }, { status: 503 });
  }
}

export async function POST(request: Request) {
  if (!readApiRole(request)) {
    return Response.json({ error: "ログインが必要です" }, { status: 401 });
  }
  if (!isSameOriginRequest(request)) {
    return Response.json({ error: "不正な送信元です" }, { status: 403 });
  }

  let body: { action?: unknown; name?: unknown; stopConfirmed?: unknown; startAfterRestore?: unknown };
  try {
    const parsed: unknown = await request.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return Response.json({ error: "不正なJSONです" }, { status: 400 });
    }
    body = parsed as typeof body;
  } catch {
    return Response.json({ error: "不正なJSONです" }, { status: 400 });
  }

  try {
    if (body.action === "create") return Response.json(await createBackup());
    if ((body.action === "restore" || body.action === "delete") && typeof body.name === "string") {
      if (!/^[a-zA-Z0-9._-]+\.tar\.gz$/.test(body.name)) {
        return Response.json({ error: "不正なバックアップ名です" }, { status: 400 });
      }
      if (body.action === "delete") return Response.json(await deleteBackup(body.name));
      if (body.stopConfirmed !== true || typeof body.startAfterRestore !== "boolean") {
        return Response.json({ error: "復元内容の確認が完了していません" }, { status: 400 });
      }
      for (const [id, operation] of restoreOperations) {
        if (operation.status !== "running" && Date.now() - operation.createdAt > 30 * 60_000) restoreOperations.delete(id);
      }
      const operationId = randomUUID();
      const operation: RestoreOperation = { createdAt: Date.now(), status: "running", logs: [] };
      restoreOperations.set(operationId, operation);
      void restoreBackup(body.name, body.startAfterRestore, (message) => appendRestoreLog(operation, message)).then((result) => {
        operation.result = result;
        operation.status = result.startError ? "warning" : "completed";
        appendRestoreLog(operation, result.startError ?? "復元処理が完了しました");
      }).catch((error: unknown) => {
        operation.error = error instanceof Error ? error.message : "復元処理に失敗しました";
        operation.status = "failed";
        appendRestoreLog(operation, `復元処理に失敗しました: ${operation.error}`);
      });
      return Response.json({ operationId }, { status: 202, headers: { "Cache-Control": "no-store" } });
    }
    return Response.json({ error: "不正なバックアップ操作です" }, { status: 400 });
  } catch (error) {
    if (error instanceof BackupError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof ComposeOperationInProgressError) {
      return Response.json({ error: error.message }, { status: 409 });
    }
    return Response.json({ error: "バックアップ操作に失敗しました" }, { status: 503 });
  }
}