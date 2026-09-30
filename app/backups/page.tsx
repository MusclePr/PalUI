"use client";

import { Archive, Check, Database, FileCheck, LayoutDashboard, Menu, RefreshCw, RotateCcw, Save, Settings, TerminalSquare, Trash2, Users, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { isErrorLogLine, renderAnsiLine } from "../components/AnsiText";
import { SidebarFooter } from "../components/SidebarFooter";

type Backup = { name: string; createdAt: string; size: string; sizeBytes: number; integrity: "検証済み" | "破損"; source: "server" };
type StorageUsage = { totalBytes: number; freeBytes: number; backupBytes: number; systemBytes: number; source: "server" | "unavailable" };

const basePath = process.env.NEXT_PUBLIC_BASE_PATH || "/palui";
const navItems = [
  { label: "ダッシュボード", icon: LayoutDashboard, href: "/dashboard" },
  { label: "プレイヤー", icon: Users, href: "/players" },
  { label: "バックアップ", icon: Database, href: "/backups", active: true },
  { label: "設定", icon: Settings, href: "/settings" },
];

export default function BackupsPage() {
  const [mobileNav, setMobileNav] = useState(false);
  const [backups, setBackups] = useState<Backup[]>([]);
  const [notice, setNotice] = useState("バックアップ一覧を取得しています...");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const [restoreTarget, setRestoreTarget] = useState<Backup | null>(null);
  const [stopConfirmed, setStopConfirmed] = useState(false);
  const [startAfterRestore, setStartAfterRestore] = useState(false);
  const [restoreStatus, setRestoreStatus] = useState<"running" | "completed" | "warning" | "failed" | null>(null);
  const [restoreLogs, setRestoreLogs] = useState<string[]>([]);
  const restoreLogRef = useRef<HTMLPreElement>(null);
  const [deleteTarget, setDeleteTarget] = useState<Backup | null>(null);
  const [storage, setStorage] = useState<StorageUsage>({ totalBytes: 0, freeBytes: 0, backupBytes: 0, systemBytes: 0, source: "unavailable" });

  useEffect(() => { void loadBackups(); }, []);
  useEffect(() => {
    if (restoreLogRef.current) restoreLogRef.current.scrollTop = restoreLogRef.current.scrollHeight;
  }, [restoreLogs]);

  async function loadBackups() {
    setLoading(true);
    try {
      const response = await fetch(`${basePath}/api/backups`, { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "一覧を取得できませんでした");
      setBackups(Array.isArray(data.backups) ? data.backups : []);
      if (data.storage) setStorage(data.storage);
      setLoadError(false);
      setLastUpdated(new Date().toISOString());
    } catch (error) {
      setBackups([]);
      setLoadError(true);
      setNotice(error instanceof Error ? error.message : "バックアップ一覧を取得できませんでした");
    } finally {
      setLoading(false);
    }
  }

  async function deleteBackup() {
    if (!deleteTarget) return;
    setBusy(true);
    try {
      const response = await fetch(`${basePath}/api/backups`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "delete", name: deleteTarget.name }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "バックアップを削除できませんでした");
      setNotice(`${deleteTarget.name} を削除しました`);
      setDeleteTarget(null);
      await loadBackups();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "バックアップを削除できませんでした");
    } finally {
      setBusy(false);
    }
  }

  const storageTotal = Math.max(storage.totalBytes, 1);
  const storagePercent = (value: number) => `${Math.min((value / storageTotal) * 100, 100)}%`;
  const formatSize = (bytes: number) => `${(bytes / (1024 ** 3)).toFixed(2)} GB`;

  async function createBackup() {
    setBusy(true);
    setNotice("バックアップを作成しています...");
    try {
      const response = await fetch(`${basePath}/api/backups`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "create" }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "バックアップを作成できませんでした");
      await loadBackups();
      setNotice("バックアップを作成しました");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "バックアップを作成できませんでした");
    } finally {
      setBusy(false);
    }
  }

  async function restoreBackup(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!restoreTarget || !stopConfirmed || restoreTarget.integrity !== "検証済み") return;
    setBusy(true);
    setNotice("復元処理を開始しています...");
    setRestoreStatus("running");
    setRestoreLogs([`${new Date().toISOString()} 復元操作を開始しています`]);
    try {
      const response = await fetch(`${basePath}/api/backups`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "restore", name: restoreTarget.name, stopConfirmed: true, startAfterRestore }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "復元に失敗しました。サーバーは停止状態です");
      if (typeof data.operationId !== "string") throw new Error("復元操作IDを取得できませんでした");

      let operation;
      do {
        const statusResponse = await fetch(`${basePath}/api/backups?operationId=${encodeURIComponent(data.operationId)}`, { cache: "no-store" });
        const statusData = await statusResponse.json();
        if (!statusResponse.ok) throw new Error(statusData.error ?? "復元の進捗を取得できませんでした");
        if (Array.isArray(statusData.logs)) setRestoreLogs(statusData.logs);
        setRestoreStatus(statusData.status);
        operation = statusData;
        if (statusData.status === "running") await new Promise((resolve) => window.setTimeout(resolve, 400));
      } while (operation.status === "running");

      await loadBackups();
      if (operation.status === "failed") {
        setNotice(operation.error ?? "復元に失敗しました。ログを確認してください");
      } else {
        const result = operation.result;
        setNotice(result?.startError ?? (result?.started ? "復元が完了し、Composeを起動しました。ダイアログのログを確認できます" : "復元が完了しました。ダイアログのログを確認できます"));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "復元に失敗しました。サーバーは停止状態です";
      setRestoreStatus("failed");
      setRestoreLogs((logs) => [...logs, `${new Date().toISOString()} ERROR ${message}`]);
      setNotice(message);
    } finally {
      setBusy(false);
    }
  }

  return <div className="app-shell">
    <aside className={`sidebar ${mobileNav ? "is-open" : ""}`}><div className="sidebar-header"><div className="brand-mark"><TerminalSquare size={19} /> PALUI</div><button className="icon-button mobile-close" onClick={() => setMobileNav(false)} aria-label="メニューを閉じる"><X size={18} /></button></div><div className="server-selector"><span className="signal-dot" /><div><small>MANAGED SERVER</small><strong>palworld-server</strong></div></div><nav className="main-nav" aria-label="メインナビゲーション"><p className="nav-label">OPERATIONS</p>{navItems.map(({ label, icon: Icon, href, active }) => <a href={href === "#" ? "#" : `${basePath}${href}`} className={active ? "active" : ""} key={label} onClick={href === "#" ? (event) => event.preventDefault() : undefined}><Icon size={17} /> {label}{active && <span className="nav-pip" />}</a>)}</nav><SidebarFooter /></aside>
    <main className="content-area"><header className="topbar"><button className="icon-button menu-trigger" onClick={() => setMobileNav(true)} aria-label="メニューを開く"><Menu size={20} /></button><div className="breadcrumbs"><span>OPERATIONS</span><b>/</b><strong>バックアップ</strong></div><div className="topbar-meta"><span className="live-indicator"><i /> LIVE</span><span className="topbar-divider" /><span className="muted">{lastUpdated ? new Date(lastUpdated).toLocaleString("ja-JP", { dateStyle: "medium", timeStyle: "short" }) : "未取得"}</span></div></header><div className="page-content">
      <div className="page-heading"><div><p className="eyebrow">DATA PROTECTION / 03</p><h1>バックアップ</h1><p className="muted">ワールドデータの保存と、検証済みバックアップからの復元。</p></div><button className="secondary-button" onClick={() => void loadBackups()} disabled={loading || busy}><RefreshCw size={15} /> 再取得</button></div>
      <div className="notice-bar"><span className="notice-icon"><Check size={14} /></span><span>{notice}</span><button aria-label="通知を閉じる" onClick={() => setNotice("")}><X size={15} /></button></div>
      <section className="backup-summary panel"><div className="backup-summary-top"><div className="backup-summary-icon"><Archive size={22} /></div><div><p className="eyebrow">STORAGE / {storage.source.toUpperCase()}</p><h2>現在のストレージ</h2><p className="muted">/server/palworld の使用状況</p></div><div className="backup-summary-stats"><span>総容量<strong>{storage.source === "server" ? formatSize(storage.totalBytes) : "取得不可"}</strong></span><span>バックアップ<strong>{storage.source === "server" ? formatSize(storage.backupBytes) : "取得不可"}</strong></span><span>空き容量<strong>{storage.source === "server" ? formatSize(storage.freeBytes) : "取得不可"}</strong></span></div></div><hr className="backup-summary-divider" /><div className="storage-panel"><div className="storage-bar" aria-label="ストレージ使用量"><span className="storage-segment system" style={{ width: storagePercent(storage.systemBytes) }} /><span className="storage-segment backup" style={{ width: storagePercent(storage.backupBytes) }} /><span className="storage-segment free" style={{ width: storagePercent(storage.freeBytes) }} /></div><div className="storage-legend"><span><i className="system" />システム使用量 <strong>{storage.source === "server" ? formatSize(storage.systemBytes) : "取得不可"}</strong></span><span><i className="backup" />バックアップ使用量 <strong>{storage.source === "server" ? formatSize(storage.backupBytes) : "取得不可"}</strong></span><span><i className="free" />空き容量 <strong>{storage.source === "server" ? formatSize(storage.freeBytes) : "取得不可"}</strong></span></div></div></section>
      <section className="panel backup-list-panel"><div className="panel-heading"><div><p className="eyebrow">ARCHIVES / {backups.length}</p><h3>バックアップ一覧</h3></div><button className="primary-button" onClick={createBackup} disabled={busy || loading}><Save size={15} /> {busy ? "処理中..." : "今すぐバックアップ"}</button></div><div className="backup-table-wrap"><table className="backup-table"><thead><tr><th>ファイル名</th><th>作成日時</th><th>サイズ</th><th>整合性</th><th><span className="sr-only">操作</span></th></tr></thead><tbody>{loading ? <tr><td colSpan={5}>バックアップ一覧を取得しています...</td></tr> : backups.length === 0 ? <tr><td colSpan={5}>{loadError ? "一覧を取得できませんでした" : "バックアップはありません"}</td></tr> : backups.map((backup) => <tr key={backup.name}><td><div className="backup-name"><Archive size={16} /><strong>{backup.name}</strong></div></td><td>{new Date(backup.createdAt).toLocaleString("ja-JP")}</td><td>{backup.size}</td><td><span className={`status-badge ${backup.integrity === "検証済み" ? "success" : "danger"}`}><FileCheck size={12} /> {backup.integrity}</span></td><td><div className="backup-actions"><button className="secondary-button" onClick={() => { setRestoreTarget(backup); setStopConfirmed(false); setStartAfterRestore(false); setRestoreStatus(null); setRestoreLogs([]); }} disabled={busy || backup.integrity !== "検証済み"} title={backup.integrity === "破損" ? "破損したバックアップは復元できません" : undefined}><RotateCcw size={14} /> 復元</button><button className="icon-button delete-backup-button" onClick={() => setDeleteTarget(backup)} aria-label={`${backup.name} を削除`} disabled={busy}><Trash2 size={15} /></button></div></td></tr>)}</tbody></table></div></section>
      <section className="backup-warning"><div><Save size={16} /><strong>backup コマンドがワールドを保存します</strong><span>PALUIから別途 rest-cli save は実行しません。</span></div><span className="status-badge success">SAFE FLOW</span></section>
    </div></main>
    {restoreTarget && <div className="dialog-backdrop" onClick={() => { if (!busy) setRestoreTarget(null); }}><section className="confirm-dialog restore-dialog" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}><div className="dialog-icon"><RotateCcw size={20} /></div><p className="eyebrow">RESTORE / IMPACT</p><h2>バックアップを復元</h2><p className="muted">対象: <strong>{restoreTarget.name}</strong><br />サーバーを停止し、現在のワールドデータを置き換えます。復元後の起動は選択できます。</p>{restoreStatus && <p className="muted">{restoreStatus === "running" ? "処理中: 最新の操作ログを表示しています" : restoreStatus === "completed" ? "復元が完了しました。ログを確認して閉じてください" : restoreStatus === "warning" ? "Compose起動時にエラーが発生しました。ログを確認してください" : "処理に失敗しました。ログを確認してください"}</p>}{restoreLogs.length > 0 && <pre ref={restoreLogRef} className="log-window" role="log" aria-live="polite" style={{ maxHeight: 220, overflowY: "auto", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{restoreLogs.flatMap((entry, entryIndex) => entry.split("\n").map((line, lineIndex) => <span key={`${entryIndex}-${lineIndex}`} className={isErrorLogLine(line) ? "restore-log-error" : undefined}>{renderAnsiLine(line)}{"\n"}</span>))}</pre>}<form onSubmit={restoreBackup}><label className="restore-check"><input type="checkbox" checked={stopConfirmed} disabled={busy || restoreStatus !== null} onChange={(event) => setStopConfirmed(event.target.checked)} /> サーバーを停止して復元することを確認しました</label><label className="restore-check"><input type="checkbox" checked={startAfterRestore} disabled={busy || restoreStatus !== null} onChange={(event) => setStartAfterRestore(event.target.checked)} /> 復元後にComposeを起動する</label><div className="dialog-actions"><button type="button" className="secondary-button" onClick={() => setRestoreTarget(null)} disabled={busy}>{busy ? "処理中..." : "閉じる"}</button>{restoreStatus === null && <button type="submit" className="primary-button destructive-button" disabled={busy || !stopConfirmed}>復元を実行</button>}</div></form></section></div>}
    {deleteTarget && <div className="dialog-backdrop" onClick={() => setDeleteTarget(null)}><section className="confirm-dialog" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}><div className="dialog-icon"><Trash2 size={20} /></div><p className="eyebrow">DELETE ARCHIVE</p><h2>バックアップを削除</h2><p className="muted">対象: <strong>{deleteTarget.name}</strong><br />このバックアップファイルを削除します。復元できなくなります。</p><div className="dialog-actions"><button className="secondary-button" onClick={() => setDeleteTarget(null)}>キャンセル</button><button className="primary-button destructive-button" onClick={deleteBackup} disabled={busy}>削除する</button></div></section></div>}
  </div>;
}