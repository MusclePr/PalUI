"use client";

import {
  Activity, AlertTriangle, Ban, Check, ChevronDown, CircleStop, Cpu, Database,
  FileText, Gauge, HardDrive, LayoutDashboard, Menu, Moon, Play,
  RefreshCw, Save, Server, Settings, Users, X,
} from "lucide-react";
import { useEffect, useState } from "react";
import { SidebarFooter } from "../components/SidebarFooter";

type ServerState = "running" | "sleeping" | "stopped" | "starting";

const fixtureInfo = {
  version: "v1.0.5.102999",
  servername: "A-B-C-D SAKURA-AN",
  description: "A-B-C-D Streamer Server",
  worldguid: "2B1A0CC1A1614048B76A4CE931342C8F",
};

const fixtureMetrics = {
  currentplayernum: 0,
  serverfps: 62,
  serverfpsaverage: 62.16,
  serverframetime: 16.11,
  days: 3,
  maxplayernum: 32,
  basecampnum: 1,
  uptime: 427,
};

const fixtureLogs = [
  ["14:32:18", "INFO", "Palworld server is listening on 0.0.0.0:8211"],
  ["14:32:16", "INFO", "World save completed in 1.24s"],
  ["14:31:52", "AUTH", "Player connected: 76561198012345678"],
  ["14:30:07", "WARN", "Server tick took 142ms (threshold: 100ms)"],
  ["14:29:44", "INFO", "Docker healthcheck passed"],
];

const navItems = [
  { label: "ダッシュボード", icon: LayoutDashboard, href: "/dashboard", active: true },
  { label: "プレイヤー", icon: Users, href: "/players" },
  { label: "バックアップ", icon: Database, href: "/backups" },
  { label: "設定", icon: Settings, href: "/settings" },
];

const basePath = process.env.NEXT_PUBLIC_BASE_PATH || "/palui";

export default function DashboardPage() {
  const [serverState, setServerState] = useState<ServerState>("running");
  const [autoPauseEnabled, setAutoPauseEnabled] = useState(true);
  const [info, setInfo] = useState(fixtureInfo);
  const [metrics, setMetrics] = useState(fixtureMetrics);
  const [notice, setNotice] = useState("すべてのシステムは正常です");
  const [mobileNav, setMobileNav] = useState(false);

  const stateMeta = {
    running: { label: "起動中", icon: Check, className: "success" },
    sleeping: { label: "休眠中", icon: Moon, className: "sleeping" },
    stopped: { label: "停止中", icon: CircleStop, className: "danger" },
    starting: { label: "起動準備中", icon: RefreshCw, className: "warning" },
  }[serverState];
  const StateIcon = stateMeta.icon;

  useEffect(() => {
    // Docker Socket をブラウザへ公開せず、認可済みのサーバー API だけを UI から参照する。
    fetch(`${basePath}/api/server/overview`)
      .then((response) => response.ok ? response.json() : null)
      .then((overview) => {
        if (!overview) return;
        if (overview.paused) setServerState("sleeping");
        if (overview.info) setInfo(overview.info);
        if (overview.metrics) setMetrics(overview.metrics);
      })
      .catch(() => undefined);
  }, []);

  function runAction(label: string, nextState?: ServerState) {
    setNotice(`${label}を実行しています...`);
    if (nextState) setServerState("starting");
    window.setTimeout(() => {
      if (nextState) setServerState(nextState);
      setNotice(`${label}が完了しました`);
    }, 650);
  }

  function toggleAutoPause() {
    const nextValue = !autoPauseEnabled;
    // 実接続時はこの分岐を Docker exec の autopause stop/continue に置き換え、
    // サーバー層で対象コンテナと運用者権限を検証してから実行する。
    fetch(`${basePath}/api/server/overview`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ autoPauseEnabled: nextValue }),
    }).catch(() => undefined);
    setAutoPauseEnabled(nextValue);
    setNotice(`AUTO PAUSE機能を${nextValue ? "オン" : "オフ"}にしました`);
  }

  return (
    <div className="app-shell">
      <aside className={`sidebar ${mobileNav ? "is-open" : ""}`}>
        <div className="sidebar-header"><div className="brand-mark"><TerminalIcon /> PALUI</div><button className="icon-button mobile-close" onClick={() => setMobileNav(false)} aria-label="メニューを閉じる"><X size={18} /></button></div>
        <div className="server-selector"><span className="signal-dot" /><div><small>MANAGED SERVER</small><strong>palworld-server</strong></div><ChevronDown size={15} /></div>
        <nav className="main-nav" aria-label="メインナビゲーション">
          <p className="nav-label">OPERATIONS</p>
          {navItems.map(({ label, icon: Icon, href, active }) => <a href={href ? `${basePath}${href}` : "#"} className={active ? "active" : ""} key={label} onClick={href ? undefined : (event) => event.preventDefault()}><Icon size={17} /> {label}{active && <span className="nav-pip" />}</a>)}
        </nav>
        <SidebarFooter />
      </aside>
      <main className="content-area">
        <header className="topbar"><button className="icon-button menu-trigger" onClick={() => setMobileNav(true)} aria-label="メニューを開く"><Menu size={20} /></button><div className="breadcrumbs"><span>OPERATIONS</span><b>/</b><strong>ダッシュボード</strong></div><div className="topbar-meta"><span className="live-indicator"><i /> LIVE</span><span className="topbar-divider" /><span className="muted">17 Sep 2026, 14:32 JST</span></div></header>
        <div className="page-content">
          <div className="page-heading"><div><p className="eyebrow">SERVER OVERVIEW / 01</p><h1>ダッシュボード</h1><p className="muted">サーバーの現在状態と直近の活動を監視しています。</p></div><button className="secondary-button" onClick={() => runAction("再取得")}><RefreshCw size={15} /> 再取得</button></div>
          <div className="notice-bar"><span className="notice-icon"><Check size={14} /></span><span>{notice}</span><button aria-label="通知を閉じる" onClick={() => setNotice("")}><X size={15} /></button></div>
          <section className="hero-status panel"><div className="status-main"><div className={`status-icon ${stateMeta.className}`}><StateIcon size={25} /></div><div><p className="eyebrow">CONTAINER STATUS</p><div className="status-title"><h2>{stateMeta.label}</h2><span className={`status-badge ${stateMeta.className}`}><StateIcon size={13} /> {stateMeta.label}</span></div><p className="muted">palworld-server · thijsvanloef/palworld-server-docker:wine</p></div></div><div className="status-details"><div><span>UPTIME</span><strong>{serverState === "running" || serverState === "sleeping" ? "3d 07h 42m" : "--"}</strong></div><div><span>RESTARTS</span><strong>0</strong></div><div><span>VERSION</span><strong>{fixtureInfo.version}</strong></div></div></section>
          <section className="metric-grid"><MetricCard icon={Cpu} label="CPU USAGE" value="18.4" unit="%" detail="6 cores allocated" tone="blue" /><MetricCard icon={HardDrive} label="MEMORY" value="4.82" unit="GB" detail="of 16 GB limit" tone="teal" /><MetricCard icon={Users} label="ONLINE PLAYERS" value={String(metrics.currentplayernum)} unit={`/ ${metrics.maxplayernum}`} detail="rest-cli metrics" tone="orange" /><MetricCard icon={Gauge} label="SERVER PERF." value={String(metrics.serverfps)} unit="FPS" detail={`average ${metrics.serverfpsaverage} FPS`} tone="green" /></section>
          <section className="dashboard-grid"><div className="panel actions-panel"><div className="panel-heading"><div><p className="eyebrow">LIFECYCLE</p><h3>サーバー操作</h3></div><span className="panel-status"><i /> READY</span></div><div className="action-grid"><ActionButton icon={Play} label="起動" onClick={() => runAction("起動", "running")} disabled={serverState === "running"} /><ActionButton icon={CircleStop} label="停止" danger onClick={() => runAction("停止", "stopped")} disabled={serverState === "stopped"} /><ActionButton icon={RefreshCw} label="再起動" onClick={() => runAction("再起動", "running")} /><ActionButton icon={Save} label="ワールドを保存" onClick={() => runAction("ワールド保存")} /></div><div className="auto-pause-row"><div><strong>AUTO PAUSE機能</strong><small>プレイヤー0人時の自動休眠</small></div><button type="button" className={`switch ${autoPauseEnabled ? "is-on" : ""}`} role="switch" aria-checked={autoPauseEnabled} aria-label="AUTO PAUSE機能" onClick={toggleAutoPause}><span /></button></div><div className="action-footnote"><AlertTriangle size={14} /> 停止・再起動には確認ダイアログが表示されます。</div></div><div className="panel info-panel"><div className="panel-heading"><div><p className="eyebrow">SERVER INFO</p><h3>サーバー情報</h3></div><Server size={18} className="muted-icon" /></div><InfoRow label="サーバー名" value={info.servername} /><InfoRow label="説明" value={info.description} /><InfoRow label="ワールド日数" value={`${metrics.days} days`} /><InfoRow label="REST API" value="内部接続" badge="PROTECTED" /></div></section>
          <section className="panel log-panel"><div className="panel-heading"><div><p className="eyebrow">STREAM / STDOUT</p><h3>リアルタイムログ</h3></div><div className="log-tools"><span className="live-indicator"><i /> STREAMING</span><button className="icon-button" aria-label="ログをダウンロード"><FileText size={16} /></button></div></div><div className="log-window">{fixtureLogs.map(([time, level, message]) => <div className="log-line" key={`${time}-${message}`}><span className="log-time">{time}</span><span className={`log-level ${level.toLowerCase()}`}>{level}</span><span>{message}</span></div>)}</div></section>
        </div>
      </main>
    </div>
  );
}

function TerminalIcon() { return <span className="terminal-icon"><span />_</span>; }
function MetricCard({ icon: Icon, label, value, unit, detail, tone }: { icon: typeof Cpu; label: string; value: string; unit: string; detail: string; tone: string }) { return <div className="metric-card"><div className={`metric-icon ${tone}`}><Icon size={17} /></div><p>{label}</p><div className="metric-value">{value}<small>{unit}</small></div><span>{detail}</span></div>; }
function ActionButton({ icon: Icon, label, onClick, disabled, danger }: { icon: typeof Play; label: string; onClick: () => void; disabled?: boolean; danger?: boolean }) { return <button className={`action-button ${danger ? "danger-action" : ""}`} onClick={onClick} disabled={disabled}><Icon size={18} /><span>{label}</span></button>; }
function InfoRow({ label, value, badge }: { label: string; value: string; badge?: string }) { return <div className="info-row"><span>{label}</span><strong>{value}</strong>{badge && <small>{badge}</small>}</div>; }