"use client";

import {
  AlertTriangle, Check, CircleStop, Cpu, Database, Gauge, HardDrive,
  LayoutDashboard, Menu, Moon, Pause, Play, RefreshCw, Server, Settings, TerminalSquare, Users, X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { LiveLogDock } from "../components/LiveLogDock";
import { SidebarFooter } from "../components/SidebarFooter";
import { ServerStatusIndicator, type ServerIndicatorState } from "../components/ServerStatusIndicator";

type ServerState = ServerIndicatorState;
type ContainerState = "not_created" | "running" | "stopped" | "starting" | "unknown";
type PalworldServerStatus = { status: Exclude<ServerState, "sleeping" | "not_created" | "unknown">; progress: number };
type LifecycleAction = "start" | "stop" | "restart";
type PalworldInfo = { version: string; servername: string; description: string; worldguid: string };
type PalworldMetrics = { currentplayernum: number; maxplayernum: number; serverfps: number; serverfpsaverage: number; days: number };
type ContainerSnapshot = {
  service: "pal";
  state: ContainerState;
  name: string | null;
  image: string | null;
  startedAt: string | null;
  restartCount: number | null;
  cpuPercent: number | null;
  memoryUsageBytes: number | null;
  memoryLimitBytes: number | null;
  statsError: string | null;
};
type DashboardOverview = {
  paused: boolean;
  info: PalworldInfo | null;
  metrics: PalworldMetrics | null;
  errors: { info: string | null; metrics: string | null };
  autoPauseEnabled: boolean | null;
  serverStatus: PalworldServerStatus | null;
  lastRefreshAt?: string | null;
  lastStatsAt?: string | null;
  lastMetricsAt?: string | null;
  dashboardCache: { version: string | null; servername: string | null; description: string | null; days: number | null; updatedAt: string | null };
  container: ContainerSnapshot;
};
type DashboardStateCache = {
  container: ContainerSnapshot;
  serverStatus: PalworldServerStatus | null;
  paused: boolean;
  autoPauseEnabled: boolean | null;
  metrics: PalworldMetrics | null;
  lastRefreshAt: string;
  lastStatsAt: string | null;
  lastMetricsAt: string | null;
};
type DashboardSnapshot = {
  version: 1;
  savedAt: number;
  container: ContainerSnapshot;
  serverStatus: PalworldServerStatus | null;
  progressComplete: boolean;
  paused: boolean;
  autoPauseEnabled: boolean | null;
  info: PalworldInfo | null;
  metrics: PalworldMetrics | null;
  dashboardCache: DashboardOverview["dashboardCache"];
  lastRefreshAt: string;
  lastStatsAt: string | null;
  lastMetricsAt: string | null;
};
type DashboardClientProps = {
  initialDashboardCache: DashboardOverview["dashboardCache"];
  initialServerStatus: PalworldServerStatus | null;
  initialSnapshot: DashboardStateCache | null;
};

const navItems = [
  { label: "ダッシュボード", icon: LayoutDashboard, href: "/dashboard", active: true },
  { label: "プレイヤー", icon: Users, href: "/players" },
  { label: "バックアップ", icon: Database, href: "/backups" },
  { label: "設定", icon: Settings, href: "/settings" },
];

const basePath = process.env.NEXT_PUBLIC_BASE_PATH || "/palui";
const dashboardSnapshotKey = `palui-dashboard-overview:${basePath}:v1`;
const dashboardSnapshotMaxAgeMs = 60_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isNullableNumber(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value));
}

function isContainerState(value: unknown): value is ContainerState {
  return value === "not_created" || value === "running" || value === "stopped" || value === "starting" || value === "unknown";
}

function isContainerSnapshot(value: unknown): value is ContainerSnapshot {
  return isRecord(value)
    && value.service === "pal"
    && isContainerState(value.state)
    && isNullableString(value.name)
    && isNullableString(value.image)
    && isNullableString(value.startedAt)
    && isNullableNumber(value.restartCount)
    && isNullableNumber(value.cpuPercent)
    && isNullableNumber(value.memoryUsageBytes)
    && isNullableNumber(value.memoryLimitBytes)
    && isNullableString(value.statsError);
}

function isPalworldInfo(value: unknown): value is PalworldInfo | null {
  return value === null || (isRecord(value)
    && typeof value.version === "string"
    && typeof value.servername === "string"
    && typeof value.description === "string"
    && typeof value.worldguid === "string");
}

function isPalworldMetrics(value: unknown): value is PalworldMetrics | null {
  return value === null || (isRecord(value)
    && typeof value.currentplayernum === "number" && Number.isFinite(value.currentplayernum)
    && typeof value.maxplayernum === "number" && Number.isFinite(value.maxplayernum)
    && typeof value.serverfps === "number" && Number.isFinite(value.serverfps)
    && typeof value.serverfpsaverage === "number" && Number.isFinite(value.serverfpsaverage)
    && typeof value.days === "number" && Number.isFinite(value.days));
}

function isDashboardMetadata(value: unknown): value is DashboardOverview["dashboardCache"] {
  return isRecord(value)
    && isNullableString(value.version)
    && isNullableString(value.servername)
    && isNullableString(value.description)
    && (value.days === null || (typeof value.days === "number" && Number.isFinite(value.days) && value.days >= 0))
    && isNullableString(value.updatedAt);
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isNullableTimestamp(value: unknown): value is string | null {
  return value === null || isTimestamp(value);
}

function isDashboardSnapshot(value: unknown): value is DashboardSnapshot {
  if (!isRecord(value) || value.version !== 1 || typeof value.savedAt !== "number" || !Number.isFinite(value.savedAt)) return false;
  const age = Date.now() - value.savedAt;
  return age >= 0
    && age <= dashboardSnapshotMaxAgeMs
    && isContainerSnapshot(value.container)
    && (value.serverStatus === null || isPalworldServerStatus(value.serverStatus))
    && typeof value.progressComplete === "boolean"
    && typeof value.paused === "boolean"
    && (value.autoPauseEnabled === null || typeof value.autoPauseEnabled === "boolean")
    && isPalworldInfo(value.info)
    && isPalworldMetrics(value.metrics)
    && isDashboardMetadata(value.dashboardCache)
    && isTimestamp(value.lastRefreshAt)
    && isNullableTimestamp(value.lastStatsAt)
    && isNullableTimestamp(value.lastMetricsAt);
}

function removeDashboardSnapshot() {
  try {
    window.sessionStorage.removeItem(dashboardSnapshotKey);
  } catch (error) {
    console.warn("ダッシュボードのキャッシュを削除できませんでした", error);
  }
}

function readDashboardSnapshot(): DashboardSnapshot | null {
  let serialized: string | null;
  try {
    serialized = window.sessionStorage.getItem(dashboardSnapshotKey);
  } catch (error) {
    console.warn("ダッシュボードのキャッシュを読み込めませんでした", error);
    return null;
  }
  if (!serialized) return null;

  let snapshot: unknown;
  try {
    snapshot = JSON.parse(serialized);
  } catch (error) {
    console.warn("ダッシュボードのキャッシュが不正なJSONです", error);
    removeDashboardSnapshot();
    return null;
  }
  if (!isDashboardSnapshot(snapshot)) {
    removeDashboardSnapshot();
    return null;
  }
  return snapshot;
}

function writeDashboardSnapshot(snapshot: DashboardSnapshot) {
  try {
    window.sessionStorage.setItem(dashboardSnapshotKey, JSON.stringify(snapshot));
  } catch (error) {
    console.warn("ダッシュボードのキャッシュを保存できませんでした", error);
  }
}

export default function DashboardClient({ initialDashboardCache, initialServerStatus, initialSnapshot }: DashboardClientProps) {
  const [container, setContainer] = useState<ContainerSnapshot | null>(initialSnapshot?.container ?? null);
  const [serverStatus, setServerStatus] = useState<PalworldServerStatus | null>(initialServerStatus);
  const [progressComplete, setProgressComplete] = useState(initialSnapshot?.serverStatus?.progress === 100);
  const [paused, setPaused] = useState(initialSnapshot?.paused ?? false);
  const [autoPauseEnabled, setAutoPauseEnabled] = useState<boolean | null>(initialSnapshot?.autoPauseEnabled ?? null);
  const [autoPauseBusy, setAutoPauseBusy] = useState(false);
  const [info, setInfo] = useState<PalworldInfo | null>(null);
  const [metrics, setMetrics] = useState<PalworldMetrics | null>(initialSnapshot?.metrics ?? null);
  const [dashboardCache, setDashboardCache] = useState<DashboardOverview["dashboardCache"]>(initialDashboardCache);
  const [lastRefreshAt, setLastRefreshAt] = useState<string | null>(initialSnapshot?.lastRefreshAt ?? initialDashboardCache.updatedAt);
  const [lastStatsAt, setLastStatsAt] = useState<string | null>(initialSnapshot?.lastStatsAt ?? null);
  const [lastMetricsAt, setLastMetricsAt] = useState<string | null>(initialSnapshot?.lastMetricsAt ?? null);
  const [notice, setNotice] = useState(
    initialSnapshot || initialServerStatus || Object.values(initialDashboardCache).some((value) => value !== null)
      ? "保存済みの状態を表示しています。最新状態を確認しています。"
      : "サーバー状態を取得しています...",
  );
  const [noticeWarning, setNoticeWarning] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshRequest, setRefreshRequest] = useState(0);
  const [lifecycleReconnectRequest, setLifecycleReconnectRequest] = useState(0);
  const [mobileNav, setMobileNav] = useState(false);
  const [pendingAction, setPendingAction] = useState<LifecycleAction | null>(null);
  const [confirmAction, setConfirmAction] = useState<"stop" | "restart" | null>(null);
  const [snapshotLoaded, setSnapshotLoaded] = useState(false);
  const dashboardSnapshotRef = useRef<DashboardSnapshot | null>(null);

  const serverState: ServerState = serverStatus?.status ?? (
    pendingAction === "stop"
      ? "stopping"
      : pendingAction === "start" || pendingAction === "restart"
        ? "starting"
        : !container
          ? "unknown"
          : container.state === "running" && paused
            ? "sleeping"
            : container.state
  );
  const serverPaused = serverStatus ? serverStatus.status === "paused" : paused;
  const progress = serverStatus?.progress ?? null;
  const shouldPollServerStatus = container?.state === "running" || container?.state === "starting" || container?.state === "unknown";

  const stateMeta = {
    running: { label: "起動完了", icon: Check, className: "success" },
    sleeping: { label: "休眠中", icon: Moon, className: "sleeping" },
    paused: { label: "一時停止", icon: Pause, className: "sleeping" },
    updating: { label: "更新中", icon: RefreshCw, className: "warning" },
    stopped: { label: "停止済み", icon: CircleStop, className: "danger" },
    starting: { label: "起動中", icon: RefreshCw, className: "warning" },
    stopping: { label: "停止処理中", icon: RefreshCw, className: "warning" },
    not_created: { label: "未作成", icon: CircleStop, className: "danger" },
    unknown: { label: "状態不明", icon: AlertTriangle, className: "warning" },
  }[serverState];
  const StateIcon = stateMeta.icon;

  useEffect(() => {
    const snapshot = readDashboardSnapshot();
    if (snapshot) {
      dashboardSnapshotRef.current = snapshot;
      setContainer(snapshot.container);
      setServerStatus(initialServerStatus ?? snapshot.serverStatus);
      setProgressComplete(snapshot.progressComplete);
      setPaused(snapshot.paused);
      setAutoPauseEnabled(snapshot.autoPauseEnabled);
      setInfo(snapshot.info);
      setMetrics(snapshot.metrics);
      setDashboardCache({
        version: initialDashboardCache.version ?? snapshot.dashboardCache.version,
        servername: initialDashboardCache.servername ?? snapshot.dashboardCache.servername,
        description: initialDashboardCache.description ?? snapshot.dashboardCache.description,
        days: initialDashboardCache.days ?? snapshot.dashboardCache.days,
        updatedAt: initialDashboardCache.updatedAt ?? snapshot.dashboardCache.updatedAt,
      });
      setLastRefreshAt(snapshot.lastRefreshAt);
      setLastStatsAt(snapshot.lastStatsAt);
      setLastMetricsAt(snapshot.lastMetricsAt);
      setNotice("前回取得した状態を表示しています。最新の状態を確認しています。");
      setNoticeWarning(false);
    }
    setSnapshotLoaded(true);
  }, [
    initialDashboardCache.days,
    initialDashboardCache.description,
    initialDashboardCache.servername,
    initialDashboardCache.updatedAt,
    initialDashboardCache.version,
    initialServerStatus,
  ]);

  useEffect(() => {
    if (!snapshotLoaded || !container || !lastRefreshAt) return;
    const snapshot: DashboardSnapshot = {
      version: 1,
      savedAt: Date.now(),
      container,
      serverStatus,
      progressComplete,
      paused,
      autoPauseEnabled,
      info,
      metrics,
      dashboardCache,
      lastRefreshAt,
      lastStatsAt,
      lastMetricsAt,
    };
    dashboardSnapshotRef.current = snapshot;
    writeDashboardSnapshot(snapshot);
  }, [snapshotLoaded, container, serverStatus, progressComplete, paused, autoPauseEnabled, info, metrics, dashboardCache, lastRefreshAt, lastStatsAt, lastMetricsAt]);

  useEffect(() => {
    if (!snapshotLoaded) return;
    function persistBeforeNavigation() {
      if (!dashboardSnapshotRef.current) return;
      const snapshot = { ...dashboardSnapshotRef.current, savedAt: Date.now() };
      dashboardSnapshotRef.current = snapshot;
      writeDashboardSnapshot(snapshot);
    }
    window.addEventListener("pagehide", persistBeforeNavigation);
    return () => window.removeEventListener("pagehide", persistBeforeNavigation);
  }, [snapshotLoaded]);

  useEffect(() => {
    if (!snapshotLoaded) return;
    if (progress !== 100) {
      setProgressComplete(false);
      return;
    }
    const timeout = window.setTimeout(() => setProgressComplete(true), 3_000);
    return () => window.clearTimeout(timeout);
  }, [progress, snapshotLoaded]);

  useEffect(() => {
    if (!shouldPollServerStatus) return;
    let active = true;
    let inFlight = false;
    const controller = new AbortController();

    async function refreshServerStatus() {
      if (inFlight) return;
      inFlight = true;
      try {
        const response = await fetch(`${basePath}/api/server/status`, { cache: "no-store", signal: controller.signal });
        const result = await response.json().catch(() => null) as { serverStatus?: unknown } | null;
        if (!response.ok) throw new Error("サーバー状態を取得できませんでした");
        if (active && isPalworldServerStatus(result?.serverStatus)) setServerStatus(result.serverStatus);
      } catch (error) {
        if (active && !controller.signal.aborted) console.warn("サーバー状態の再取得に失敗しました", error);
      } finally {
        inFlight = false;
      }
    }

    function refreshWhenVisible() {
      if (document.visibilityState === "visible") void refreshServerStatus();
    }

    void refreshServerStatus();
    const interval = window.setInterval(refreshWhenVisible, 1_000);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      active = false;
      controller.abort();
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [shouldPollServerStatus]);

  useEffect(() => {
    let active = true;
    let inFlight = false;
    const controller = new AbortController();

    async function refreshOverview() {
      if (inFlight) return;
      inFlight = true;
      setRefreshing(true);
      try {
        const response = await fetch(`${basePath}/api/server/overview`, { cache: "no-store", signal: controller.signal });
        const result = await response.json().catch(() => null) as (DashboardOverview & { error?: string }) | null;
        if (!response.ok || !result) throw new Error(result?.error ?? "サーバー状態を取得できませんでした");
        if (!result.container || !result.errors || !result.dashboardCache) throw new Error("サーバー情報の応答形式が不正です");
        if (!active) return;

        const observedAt = new Date().toISOString();
        setContainer((current) => {
          const unavailable = result.container.state === "unknown";
          return {
            ...result.container,
            state: unavailable && current && current.state !== "unknown" ? current.state : result.container.state,
            name: result.container.name ?? (unavailable ? current?.name : null) ?? null,
            image: result.container.image ?? (unavailable ? current?.image : null) ?? null,
            startedAt: result.container.startedAt ?? (unavailable ? current?.startedAt : null) ?? null,
            restartCount: result.container.restartCount ?? (unavailable ? current?.restartCount : null) ?? null,
            cpuPercent: result.container.cpuPercent ?? current?.cpuPercent ?? null,
            memoryUsageBytes: result.container.memoryUsageBytes ?? current?.memoryUsageBytes ?? null,
            memoryLimitBytes: result.container.memoryLimitBytes ?? current?.memoryLimitBytes ?? null,
          };
        });
        if (isPalworldServerStatus(result.serverStatus)) setServerStatus(result.serverStatus);
        else if (result.container.state !== "unknown") setServerStatus(null);
        setPaused(result.paused);
        if (result.info) setInfo(result.info);
        if (result.metrics) setMetrics(result.metrics);
        setDashboardCache((current) => ({
          version: result.dashboardCache.version ?? current.version,
          servername: result.dashboardCache.servername ?? current.servername,
          description: result.dashboardCache.description ?? current.description,
          days: result.dashboardCache.days ?? current.days,
          updatedAt: result.dashboardCache.updatedAt ?? current.updatedAt,
        }));
        if (result.lastRefreshAt) setLastRefreshAt(result.lastRefreshAt);
        if (result.lastStatsAt) setLastStatsAt(result.lastStatsAt);
        else if (result.container.cpuPercent !== null || result.container.memoryUsageBytes !== null) setLastStatsAt(observedAt);
        if (result.lastMetricsAt) setLastMetricsAt(result.lastMetricsAt);
        else if (result.metrics) setLastMetricsAt(observedAt);
        if (typeof result.autoPauseEnabled === "boolean") setAutoPauseEnabled(result.autoPauseEnabled);
        if (!result.lastRefreshAt) setLastRefreshAt(observedAt);

        const errors = [result.container.statsError, result.errors.info, result.errors.metrics].filter(Boolean);
        setNoticeWarning(errors.length > 0);
        setNotice(errors.length > 0 ? errors.join(" / ") : result.paused ? "PalサーバーはAUTO PAUSE中です" : result.container.state === "running" ? "Palサーバーの状態は最新です" : `Palコンテナ: ${stateMetaLabel(result.container.state)}`);
      } catch (error) {
        if (active && !controller.signal.aborted) {
          setNotice(error instanceof Error ? error.message : "サーバー状態を取得できませんでした");
          setNoticeWarning(true);
        }
      } finally {
        inFlight = false;
        if (active) setRefreshing(false);
      }
    }

    function refreshWhenVisible() {
      if (document.visibilityState === "visible") void refreshOverview();
    }

    void refreshOverview();
    const interval = window.setInterval(refreshWhenVisible, 15_000);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      active = false;
      controller.abort();
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [refreshRequest]);

  async function runAction(action: LifecycleAction) {
    const labels: Record<LifecycleAction, string> = { start: "起動", stop: "停止", restart: "再起動" };
    setPendingAction(action);
    setConfirmAction(null);
    setNotice(`${labels[action]}を実行しています...`);
    setNoticeWarning(true);
    try {
      const response = await fetch(`${basePath}/api/server/lifecycle`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const result = await response.json().catch(() => null) as { error?: string } | null;
      if (!response.ok) throw new Error(result?.error ?? `${labels[action]}に失敗しました`);
      setNotice(`${labels[action]}が完了しました`);
      setNoticeWarning(false);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : `${labels[action]}に失敗しました`);
      setNoticeWarning(true);
    } finally {
      setPendingAction(null);
      setRefreshRequest((current) => current + 1);
      setLifecycleReconnectRequest((current) => current + 1);
    }
  }

  async function toggleAutoPause() {
    if (autoPauseEnabled === null || autoPauseBusy) return;
    const nextValue = !autoPauseEnabled;
    setAutoPauseBusy(true);
    try {
      const response = await fetch(`${basePath}/api/server/overview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ autoPauseEnabled: nextValue }),
      });
      const result = await response.json().catch(() => null) as { enabled?: unknown; error?: string } | null;
      if (!response.ok || typeof result?.enabled !== "boolean") throw new Error(result?.error ?? "AUTO PAUSE機能を変更できませんでした");
      setAutoPauseEnabled(result.enabled);
      setNotice(`AUTO PAUSE機能を${result.enabled ? "オン" : "オフ"}にしました`);
      setNoticeWarning(false);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "AUTO PAUSE機能を変更できませんでした");
      setNoticeWarning(true);
    } finally {
      setAutoPauseBusy(false);
      setRefreshRequest((current) => current + 1);
    }
  }

  return (
    <div className="app-shell dashboard-shell">
      <aside className={`sidebar ${mobileNav ? "is-open" : ""}`}>
        <div className="sidebar-header"><div className="brand-mark"><TerminalSquare size={19} /> PALUI</div><button className="icon-button mobile-close" onClick={() => setMobileNav(false)} aria-label="メニューを閉じる"><X size={18} /></button></div>
        <div className="server-selector"><ServerStatusIndicator state={serverState} /><div><small>MANAGED SERVER</small><strong>palworld-server</strong></div></div>
        <nav className="main-nav" aria-label="メインナビゲーション">
          <p className="nav-label">OPERATIONS</p>
          {navItems.map(({ label, icon: Icon, href, active }) => <a href={href ? `${basePath}${href}` : "#"} className={active ? "active" : ""} key={label} onClick={href ? undefined : (event) => event.preventDefault()}><Icon size={17} /> {label}{active && <span className="nav-pip" />}</a>)}
        </nav>
        <SidebarFooter />
      </aside>
      <main className="content-area">
        <header className="topbar"><button className="icon-button menu-trigger" onClick={() => setMobileNav(true)} aria-label="メニューを開く"><Menu size={20} /></button><div className="breadcrumbs"><span>OPERATIONS</span><b>/</b><strong>ダッシュボード</strong></div><div className="topbar-meta"><span className="live-indicator"><i /> {container?.state === "running" ? "LIVE" : "POLLING"}</span><span className="topbar-divider" /><span className="muted">{lastRefreshAt ? new Date(lastRefreshAt).toLocaleString("ja-JP", { hour12: false }) : "未取得"}</span></div></header>
        <div className="page-content">
          <div className="page-heading"><div><p className="eyebrow">SERVER OVERVIEW / 01</p><h1>ダッシュボード</h1><p className="muted">Palサービスの状態とゲーム指標。</p></div><button className="secondary-button" onClick={() => setRefreshRequest((current) => current + 1)} disabled={refreshing}><RefreshCw size={15} /> {refreshing ? "取得中..." : "再取得"}</button></div>
          <div className={`notice-bar ${noticeWarning ? "notice-warning" : ""}`}><span className="notice-icon">{noticeWarning ? <AlertTriangle size={14} /> : <Check size={14} />}</span><span>{notice}</span><button aria-label="通知を閉じる" onClick={() => setNotice("")}><X size={15} /></button></div>
          <section className="hero-status panel">
            <div className="status-main">
              <div className={`status-icon ${stateMeta.className}`}><StateIcon size={25} /></div>
              <div>
                <p className="eyebrow">PAL CONTAINER</p>
                <div className="status-title"><h2>{stateMeta.label}</h2><span className={`status-badge ${stateMeta.className}`}><StateIcon size={13} /> {stateMeta.label}</span></div>
                <p className="muted">{container?.name ?? "Compose service: pal"} · {container?.image ?? "イメージ未取得"}</p>
                <div className="server-progress-slot">
                  {serverStatus && !(serverStatus.progress === 100 && progressComplete) && <div className="server-progress">
                    <div className="server-progress-meta"><span>PROGRESS</span><strong>{Math.round(serverStatus.progress)}%</strong></div>
                    <div className="server-progress-track" role="progressbar" aria-label="サーバー処理の進捗" aria-valuemin={0} aria-valuemax={100} aria-valuenow={serverStatus.progress}><span style={{ width: `${serverStatus.progress}%` }} /></div>
                  </div>}
                </div>
              </div>
            </div>
            <div className="status-details">
              <div><span>UPTIME</span><strong>{container?.state === "running" ? formatUptime(container.startedAt) : "--"}</strong></div>
              <div><span>RESTARTS</span><strong>{container?.restartCount ?? "--"}</strong></div>
              <div><span>VERSION</span><strong>{info?.version || dashboardCache.version || "--"}</strong></div>
            </div>
          </section>
          <section className="metric-grid"><MetricCard icon={Cpu} label="CPU USAGE" value={container?.cpuPercent === null || container?.cpuPercent === undefined ? "--" : container.cpuPercent.toFixed(1)} unit="%" detail={lastStatsAt ? `Docker stats · ${formatObservedAt(lastStatsAt)}` : "Docker stats 未取得"} tone="blue" /><MetricCard icon={HardDrive} label="MEMORY" value={formatMemory(container?.memoryUsageBytes ?? null)} unit="GB" detail={container?.memoryLimitBytes ? `of ${formatMemory(container.memoryLimitBytes)} GB limit` : lastStatsAt ? `最終取得 ${formatObservedAt(lastStatsAt)}` : "Docker stats 未取得"} tone="teal" /><MetricCard icon={Users} label="ONLINE PLAYERS" value={serverPaused ? "0" : metrics ? String(metrics.currentplayernum) : "--"} unit={serverPaused ? "" : metrics ? `/ ${metrics.maxplayernum}` : ""} detail={serverPaused ? "AUTO PAUSE中" : lastMetricsAt ? `rest-cli · ${formatObservedAt(lastMetricsAt)}` : "rest-cli 未取得"} tone="orange" /><MetricCard icon={Gauge} label="SERVER PERF." value={metrics ? String(metrics.serverfps) : "--"} unit="FPS" detail={metrics ? `average ${metrics.serverfpsaverage} FPS` : "rest-cli 未取得"} tone="green" /></section>
          <section className="dashboard-grid">
            <div className="panel actions-panel">
              <div className="panel-heading">
                <div><p className="eyebrow">COMPOSE / ALL SERVICES</p><h3>サーバー操作</h3></div>
                <span className="panel-status"><i /> {pendingAction || autoPauseBusy ? "BUSY" : "READY"}</span>
              </div>
              <div className="action-grid">
                <ActionButton icon={Play} label={pendingAction === "start" ? "起動中..." : "起動"} onClick={() => void runAction("start")} disabled={pendingAction !== null || autoPauseBusy || serverState === "running" || serverState === "sleeping" || serverState === "paused" || serverState === "starting" || serverState === "updating"} />
                <ActionButton icon={CircleStop} label={pendingAction === "stop" ? "停止中..." : "停止"} onClick={() => setConfirmAction("stop")} danger disabled={pendingAction !== null || autoPauseBusy} />
                <ActionButton icon={RefreshCw} label={pendingAction === "restart" ? "再起動中..." : "再起動"} onClick={() => setConfirmAction("restart")} disabled={pendingAction !== null || autoPauseBusy} />
              </div>
              <div className="auto-pause-row">
                <div><strong>AUTO PAUSE機能</strong><small>{autoPauseEnabled === null ? "設定状態を取得できません" : "プレイヤー0人時の自動休眠"}</small></div>
                <button type="button" className={`switch ${autoPauseEnabled ? "is-on" : ""}`} role="switch" aria-checked={autoPauseEnabled === true} aria-label="AUTO PAUSE機能" onClick={() => void toggleAutoPause()} disabled={autoPauseEnabled === null || autoPauseBusy || (serverState !== "running" && serverState !== "sleeping" && serverState !== "paused")}><span /></button>
              </div>
              <div className="action-footnote"><AlertTriangle size={14} /> 起動・停止・再起動はpal / map全体に適用されます。</div>
            </div>
            <div className="panel info-panel">
              <div className="panel-heading"><div><p className="eyebrow">SERVER INFO</p><h3>サーバー情報</h3></div><Server size={18} className="muted-icon" /></div>
              <InfoRow label="サーバー名" value={info?.servername || dashboardCache.servername || "--"} badge={!info?.servername && dashboardCache.servername ? "CACHE" : undefined} />
              <InfoRow label="説明" value={info?.description || dashboardCache.description || "--"} badge={!info?.description && dashboardCache.description ? "CACHE" : undefined} />
              <InfoRow label="ワールド日数" value={metrics && Number.isFinite(metrics.days) ? `${metrics.days} days` : dashboardCache.days === null ? "--" : `${dashboardCache.days} days`} badge={(!metrics || !Number.isFinite(metrics.days)) && dashboardCache.days !== null ? "CACHE" : undefined} />
              <InfoRow label="REST API" value={serverState === "running" || serverState === "sleeping" || serverState === "paused" ? "内部接続" : "未接続"} badge={serverState === "running" || serverState === "sleeping" || serverState === "paused" ? "PROTECTED" : undefined} />
            </div>
          </section>
          {confirmAction && <div className="dialog-backdrop" onClick={() => setConfirmAction(null)}><section className="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="lifecycle-confirm-title" onClick={(event) => event.stopPropagation()}><div className="dialog-icon"><AlertTriangle size={20} /></div><p className="eyebrow">COMPOSE / ALL SERVICES</p><h2 id="lifecycle-confirm-title">{confirmAction === "stop" ? "Compose全体を停止" : "Compose全体を再起動"}</h2><p className="muted">{confirmAction === "stop" ? "pal、mapのコンテナを停止し、Composeネットワークを削除します。" : "pal、mapをdownしてからup -dで起動します。環境変数も再読み込みされます。"}</p><div className="dialog-actions"><button type="button" className="secondary-button" onClick={() => setConfirmAction(null)}>キャンセル</button><button type="button" className="primary-button destructive-button" disabled={pendingAction !== null || autoPauseBusy} onClick={() => void runAction(confirmAction)}>{confirmAction === "stop" ? "停止する" : "再起動する"}</button></div></section></div>}
        </div>
        <LiveLogDock lifecycleReconnectRequest={lifecycleReconnectRequest} />
      </main>
    </div>
  );
}

function isPalworldServerStatus(value: unknown): value is PalworldServerStatus {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const status = (value as { status?: unknown }).status;
  const progress = (value as { progress?: unknown }).progress;
  return typeof status === "string"
    && ["starting", "updating", "running", "stopping", "paused", "stopped"].includes(status)
    && typeof progress === "number"
    && Number.isFinite(progress)
    && progress >= 0
    && progress <= 100;
}
function MetricCard({ icon: Icon, label, value, unit, detail, tone }: { icon: typeof Cpu; label: string; value: string; unit: string; detail: string; tone: string }) { return <div className="metric-card"><div className={`metric-icon ${tone}`}><Icon size={17} /></div><p>{label}</p><div className="metric-value">{value}<small>{unit}</small></div><span>{detail}</span></div>; }
function ActionButton({ icon: Icon, label, onClick, disabled, danger }: { icon: typeof Play; label: string; onClick: () => void; disabled?: boolean; danger?: boolean }) { return <button className={`action-button ${danger ? "danger-action" : ""}`} onClick={onClick} disabled={disabled}><Icon size={18} /><span>{label}</span></button>; }
function InfoRow({ label, value, badge }: { label: string; value: string; badge?: string }) { return <div className="info-row"><span>{label}</span><strong>{value}</strong>{badge && <small>{badge}</small>}</div>; }

function formatUptime(startedAt: string | null) {
  if (!startedAt) return "--";
  const elapsed = Date.now() - Date.parse(startedAt);
  if (!Number.isFinite(elapsed) || elapsed < 0) return "--";
  const minutes = Math.floor(elapsed / 60_000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  return `${days}d ${String(hours).padStart(2, "0")}h ${String(minutes % 60).padStart(2, "0")}m`;
}

function formatMemory(bytes: number | null) {
  return bytes === null ? "--" : (bytes / 1024 ** 3).toFixed(2);
}

function formatObservedAt(value: string) {
  return new Date(value).toLocaleTimeString("ja-JP", { hour12: false });
}

function stateMetaLabel(state: ContainerSnapshot["state"]) {
  return { running: "起動中", stopped: "停止中", starting: "起動準備中", not_created: "未作成", unknown: "状態不明" }[state];
}