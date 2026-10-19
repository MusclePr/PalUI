"use client";

import { useEffect, useState } from "react";

export type ServerIndicatorState = "running" | "sleeping" | "paused" | "updating" | "stopped" | "starting" | "stopping" | "not_created" | "unknown";
type ServerFileStatus = Exclude<ServerIndicatorState, "sleeping" | "not_created" | "unknown">;
type StatusResponse = { serverStatus: { status: ServerFileStatus; progress: number } | null; paused: boolean };

const basePath = process.env.NEXT_PUBLIC_BASE_PATH || "/palui";
const statusIntervalMs = 5_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isServerFileStatus(value: unknown): value is ServerFileStatus {
  return value === "starting" || value === "updating" || value === "running"
    || value === "stopping" || value === "paused" || value === "stopped";
}

function isStatusResponse(value: unknown): value is StatusResponse {
  if (!isRecord(value) || typeof value.paused !== "boolean") return false;
  if (value.serverStatus === null) return true;
  return isRecord(value.serverStatus)
    && isServerFileStatus(value.serverStatus.status)
    && typeof value.serverStatus.progress === "number"
    && Number.isFinite(value.serverStatus.progress);
}

const statusLabels: Record<ServerIndicatorState, string> = {
  running: "稼働中",
  sleeping: "休眠中",
  paused: "一時停止中",
  updating: "更新中",
  stopped: "停止中",
  starting: "起動中",
  stopping: "停止処理中",
  not_created: "未作成",
  unknown: "状態不明",
};

export function ServerStatusIndicator({ state }: { state?: ServerIndicatorState }) {
  const [remoteStatus, setRemoteStatus] = useState<{ serverStatus: ServerFileStatus | null; paused: boolean }>({ serverStatus: null, paused: false });

  useEffect(() => {
    if (state !== undefined) return;
    let active = true;
    let inFlight = false;
    const controller = new AbortController();

    async function refresh() {
      if (inFlight) return;
      inFlight = true;
      try {
        const response = await fetch(`${basePath}/api/server/status`, { cache: "no-store", signal: controller.signal });
        const payload: unknown = await response.json().catch(() => null);
        if (!response.ok) {
          const message = isRecord(payload) && typeof payload.error === "string" ? payload.error : "サーバー状態を取得できませんでした";
          throw new Error(message);
        }
        if (!isStatusResponse(payload)) throw new Error("サーバー状態の応答形式が不正です");
        if (active) setRemoteStatus({ serverStatus: payload.serverStatus?.status ?? null, paused: payload.paused });
      } catch (error) {
        if (active && !controller.signal.aborted) console.warn("サイドバーのサーバー状態取得に失敗しました", error);
      } finally {
        inFlight = false;
      }
    }

    function refreshWhenVisible() {
      if (document.visibilityState === "visible") void refresh();
    }

    void refresh();
    const interval = window.setInterval(refreshWhenVisible, statusIntervalMs);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      active = false;
      controller.abort();
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [state]);

  const currentState = state ?? remoteStatus.serverStatus ?? (remoteStatus.paused ? "sleeping" : "unknown");
  const isPaused = currentState === "paused" || currentState === "sleeping";
  const className = isPaused ? "is-paused" : currentState === "running" ? "" : "is-idle";
  const label = `Palworldサーバー: ${statusLabels[currentState]}`;

  return <span className={`signal-dot ${className}`} role="img" aria-label={label} title={label} />;
}
