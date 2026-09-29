"use client";

import {
  AlertTriangle, Check, ChevronDown, CircleStop, Cpu, Database, Gauge, HardDrive,
  LayoutDashboard, Menu, Moon, Play, RefreshCw, Server, Settings, Users, X,
} from "lucide-react";
import { useEffect, useState } from "react";
import { LiveLogDock } from "../components/LiveLogDock";
import { SidebarFooter } from "../components/SidebarFooter";

type ServerState = "running" | "sleeping" | "stopped" | "starting" | "stopping" | "not_created" | "unknown";
type LifecycleAction = "start" | "stop" | "restart";
type PalworldInfo = { version: string; servername: string; description: string; worldguid: string };
type PalworldMetrics = { currentplayernum: number; maxplayernum: number; serverfps: number; serverfpsaverage: number; days: number };
type ContainerSnapshot = {
  service: "pal";
  state: Exclude<ServerState, "sleeping" | "stopping">;
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
  dashboardCache: { version: string | null; servername: string | null; description: string | null; days: number | null; updatedAt: string | null };
  container: ContainerSnapshot;
};

const navItems = [
  { label: "ダッシュボード", icon: LayoutDashboard, href: "/dashboard", active: true },
  { label: "プレイヤー", icon: Users, href: "/players" },
  { label: "バックアップ", icon: Database, href: "/backups" },
  { label: "設定", icon: Settings, href: "/settings" },
];

const basePath = process.env.NEXT_PUBLIC_BASE_PATH || "/palui";

export default function DashboardPage() {
  const [container, setContainer] = useState<ContainerSnapshot | null>(null);
  const [paused, setPaused] = useState(false);
  const [autoPauseEnabled, setAutoPauseEnabled] = useState<boolean | null>(null);
  const [autoPauseBusy, setAutoPauseBusy] = useState(false);
  const [info, setInfo] = useState<PalworldInfo | null>(null);
  const [metrics, setMetrics] = useState<PalworldMetrics | null>(null);
  const [dashboardCache, setDashboardCache] = useState<DashboardOverview["dashboardCache"]>({ version: null, servername: null, description: null, days: null, updatedAt: null });
  const [lastRefreshAt, setLastRefreshAt] = useState<string | null>(null);
  const [lastStatsAt, setLastStatsAt] = useState<string | null>(null);
  const [lastMetricsAt, setLastMetricsAt] = useState<string | null>(null);
  const [notice, setNotice] = useState("サーバー状態を取得しています...");
  const [noticeWarning, setNoticeWarning] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshRequest, setRefreshRequest] = useState(0);
  const [mobileNav, setMobileNav] = useState(false);
  const [pendingAction, setPendingAction] = useState<LifecycleAction | null>(null);
  const [confirmAction, setConfirmAction] = useState<"stop" | "restart" | null>(null);

  const serverState: ServerState = pendingAction === "stop"
    ? "stopping"
    : pendingAction === "start" || pendingAction === "restart"
      ? "starting"
      : !container
        ? "unknown"
        : container.state === "running" && paused
          ? "sleeping"
          : container.state;

  const stateMeta = {
    running: { label: "起動完了", icon: Check, className: "success" },
    sleeping: { label: "休眠中", icon: Moon, className: "sleeping" },
    stopped: { label: "停止中", icon: CircleStop, className: "danger" },
    starting: { label: "起動中", icon: RefreshCw, className: "warning" },
    stopping: { label: "停止処理中", icon: RefreshCw, className: "warning" },
    not_created: { label: "未作成", icon: CircleStop, className: "danger" },
    unknown: { label: "状態不明", icon: AlertTriangle, className: "warning" },
  }[serverState];
  const StateIcon = stateMeta.icon;

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
        setContainer((current) => ({
          ...result.container,
          cpuPercent: result.container.cpuPercent ?? current?.cpuPercent ?? null,
          memoryUsageBytes: result.container.memoryUsageBytes ?? current?.memoryUsageBytes ?? null,
          memoryLimitBytes: result.container.memoryLimitBytes ?? current?.memoryLimitBytes ?? null,
        }));
        setPaused(result.paused);
        setInfo(result.info ?? null);
        setMetrics(result.metrics ?? null);
        setDashboardCache(result.dashboardCache);
        if (result.metrics) {
          setLastMetricsAt(observedAt);
        }
        if (typeof result.autoPauseEnabled === "boolean") setAutoPauseEnabled((current) => current ?? result.autoPauseEnabled);
        if (result.container.cpuPercent !== null || result.container.memoryUsageBytes !== null) setLastStatsAt(observedAt);
        setLastRefreshAt(observedAt);

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
      setConfirmAction(null);
      setRefreshRequest((current) => current + 1);
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
        <div className="sidebar-header"><div className="brand-mark"><TerminalIcon /> PALUI</div><button className="icon-button mobile-close" onClick={() => setMobileNav(false)} aria-label="メニューを閉じる"><X size={18} /></button></div>
        <div className="server-selector"><span className={`signal-dot ${serverState === "running" ? "" : "is-idle"}`} /><div><small>MONITORED SERVICE</small><strong>pal</strong></div><ChevronDown size={15} /></div>
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
          <section className="hero-status panel"><div className="status-main"><div className={`status-icon ${stateMeta.className}`}><StateIcon size={25} /></div><div><p className="eyebrow">PAL CONTAINER</p><div className="status-title"><h2>{stateMeta.label}</h2><span className={`status-badge ${stateMeta.className}`}><StateIcon size={13} /> {stateMeta.label}</span></div><p className="muted">{container?.name ?? "Compose service: pal"} · {container?.image ?? "イメージ未取得"}</p></div></div><div className="status-details"><div><span>UPTIME</span><strong>{container?.state === "running" ? formatUptime(container.startedAt) : "--"}</strong></div><div><span>RESTARTS</span><strong>{container?.restartCount ?? "--"}</strong></div><div><span>VERSION</span><strong>{info?.version || dashboardCache.version || "--"}</strong></div></div></section>
          <section className="metric-grid"><MetricCard icon={Cpu} label="CPU USAGE" value={container?.cpuPercent === null || container?.cpuPercent === undefined ? "--" : container.cpuPercent.toFixed(1)} unit="%" detail={lastStatsAt ? `Docker stats · ${formatObservedAt(lastStatsAt)}` : "Docker stats 未取得"} tone="blue" /><MetricCard icon={HardDrive} label="MEMORY" value={formatMemory(container?.memoryUsageBytes ?? null)} unit="GB" detail={container?.memoryLimitBytes ? `of ${formatMemory(container.memoryLimitBytes)} GB limit` : lastStatsAt ? `最終取得 ${formatObservedAt(lastStatsAt)}` : "Docker stats 未取得"} tone="teal" /><MetricCard icon={Users} label="ONLINE PLAYERS" value={paused ? "0" : metrics ? String(metrics.currentplayernum) : "--"} unit={paused ? "" : metrics ? `/ ${metrics.maxplayernum}` : ""} detail={paused ? "AUTO PAUSE中" : lastMetricsAt ? `rest-cli · ${formatObservedAt(lastMetricsAt)}` : "rest-cli 未取得"} tone="orange" /><MetricCard icon={Gauge} label="SERVER PERF." value={metrics ? String(metrics.serverfps) : "--"} unit="FPS" detail={metrics ? `average ${metrics.serverfpsaverage} FPS` : "rest-cli 未取得"} tone="green" /></section>
          <section className="dashboard-grid">
            <div className="panel actions-panel">
              <div className="panel-heading">
                <div><p className="eyebrow">COMPOSE / ALL SERVICES</p><h3>サーバー操作</h3></div>
                <span className="panel-status"><i /> {pendingAction || autoPauseBusy ? "BUSY" : "READY"}</span>
              </div>
              <div className="action-grid">
                <ActionButton icon={Play} label={pendingAction === "start" ? "起動中..." : "起動"} onClick={() => void runAction("start")} disabled={pendingAction !== null || autoPauseBusy || serverState === "running" || serverState === "sleeping" || serverState === "starting"} />
                <ActionButton icon={CircleStop} label={pendingAction === "stop" ? "停止中..." : "停止"} onClick={() => setConfirmAction("stop")} danger disabled={pendingAction !== null || autoPauseBusy} />
                <ActionButton icon={RefreshCw} label={pendingAction === "restart" ? "再起動中..." : "再起動"} onClick={() => setConfirmAction("restart")} disabled={pendingAction !== null || autoPauseBusy} />
              </div>
              <div className="auto-pause-row">
                <div><strong>AUTO PAUSE機能</strong><small>{autoPauseEnabled === null ? "設定状態を取得できません" : "プレイヤー0人時の自動休眠"}</small></div>
                <button type="button" className={`switch ${autoPauseEnabled ? "is-on" : ""}`} role="switch" aria-checked={autoPauseEnabled === true} aria-label="AUTO PAUSE機能" onClick={() => void toggleAutoPause()} disabled={autoPauseEnabled === null || autoPauseBusy || (serverState !== "running" && serverState !== "sleeping")}><span /></button>
              </div>
              <div className="action-footnote"><AlertTriangle size={14} /> 起動・停止・再起動はpal / proxy / map全体に適用されます。</div>
            </div>
            <div className="panel info-panel">
              <div className="panel-heading"><div><p className="eyebrow">SERVER INFO</p><h3>サーバー情報</h3></div><Server size={18} className="muted-icon" /></div>
              <InfoRow label="サーバー名" value={info?.servername || dashboardCache.servername || "--"} badge={!info?.servername && dashboardCache.servername ? "CACHE" : undefined} />
              <InfoRow label="説明" value={info?.description || dashboardCache.description || "--"} badge={!info?.description && dashboardCache.description ? "CACHE" : undefined} />
              <InfoRow label="ワールド日数" value={metrics && Number.isFinite(metrics.days) ? `${metrics.days} days` : dashboardCache.days === null ? "--" : `${dashboardCache.days} days`} badge={(!metrics || !Number.isFinite(metrics.days)) && dashboardCache.days !== null ? "CACHE" : undefined} />
              <InfoRow label="REST API" value={serverState === "running" || serverState === "sleeping" ? "内部接続" : "未接続"} badge={serverState === "running" || serverState === "sleeping" ? "PROTECTED" : undefined} />
            </div>
          </section>
          {confirmAction && <div className="dialog-backdrop" onClick={() => setConfirmAction(null)}><section className="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="lifecycle-confirm-title" onClick={(event) => event.stopPropagation()}><div className="dialog-icon"><AlertTriangle size={20} /></div><p className="eyebrow">COMPOSE / ALL SERVICES</p><h2 id="lifecycle-confirm-title">{confirmAction === "stop" ? "Compose全体を停止" : "Compose全体を再起動"}</h2><p className="muted">{confirmAction === "stop" ? "pal、proxy、mapのコンテナを停止し、Composeネットワークを削除します。" : "pal、proxy、mapをdownしてからup -dで起動します。環境変数も再読み込みされます。"}</p><div className="dialog-actions"><button type="button" className="secondary-button" onClick={() => setConfirmAction(null)}>キャンセル</button><button type="button" className="primary-button destructive-button" disabled={pendingAction !== null || autoPauseBusy} onClick={() => void runAction(confirmAction)}>{confirmAction === "stop" ? "停止する" : "再起動する"}</button></div></section></div>}
        </div>
        <LiveLogDock />
      </main>
    </div>
  );
}

function TerminalIcon() { return <span className="terminal-icon"><span />_</span>; }
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