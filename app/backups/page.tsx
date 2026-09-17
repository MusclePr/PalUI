"use client";

import { Archive, Check, Database, FileCheck, LayoutDashboard, LogOut, Menu, RefreshCw, RotateCcw, Save, Settings, TerminalSquare, Trash2, Users, X } from "lucide-react";
import { useEffect, useState } from "react";

type Backup = { name: string; createdAt: string; size: string; sizeBytes?: number; integrity: "検証済み" | "未検証"; source: "server" | "fixture" };
type StorageUsage = { totalBytes: number; freeBytes: number; backupBytes: number; systemBytes: number; source: "server" | "fixture" };

const fixtureBackups: Backup[] = [
  { name: "palworld-2026-09-17-1430.tar.gz", createdAt: "2026-09-17T14:30:00+09:00", size: "1.82 GB", integrity: "検証済み", source: "fixture" },
  { name: "palworld-2026-09-16-2200.tar.gz", createdAt: "2026-09-16T22:00:00+09:00", size: "1.79 GB", integrity: "検証済み", source: "fixture" },
  { name: "palworld-2026-09-15-2200.tar.gz", createdAt: "2026-09-15T22:00:00+09:00", size: "1.75 GB", integrity: "未検証", source: "fixture" },
];

const basePath = process.env.NEXT_PUBLIC_BASE_PATH || "/palui";
const navItems = [
  { label: "ダッシュボード", icon: LayoutDashboard, href: "/dashboard" },
  { label: "プレイヤー", icon: Users, href: "/players" },
  { label: "バックアップ", icon: Database, href: "/backups", active: true },
  { label: "設定", icon: Settings, href: "/settings" },
];

export default function BackupsPage() {
  const [mobileNav, setMobileNav] = useState(false);
  const [backups, setBackups] = useState(fixtureBackups);
  const [notice, setNotice] = useState("3件のバックアップが利用できます");
  const [busy, setBusy] = useState(false);
  const [restoreTarget, setRestoreTarget] = useState<Backup | null>(null);
  const [restoreName, setRestoreName] = useState("");
  const [stopConfirmed, setStopConfirmed] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Backup | null>(null);
  const [storage, setStorage] = useState<StorageUsage>({ totalBytes: 100 * 1024 ** 3, freeBytes: 63.24 * 1024 ** 3, backupBytes: 5.36 * 1024 ** 3, systemBytes: 31.4 * 1024 ** 3, source: "fixture" });

  useEffect(() => { loadBackups(); }, []);

  async function loadBackups() {
    const response = await fetch(`${basePath}/api/backups`);
    if (response.ok) {
      const data = await response.json();
      if (Array.isArray(data.backups) && data.backups.length > 0) setBackups(data.backups);
      if (data.storage) setStorage(data.storage);
    }
  }

  async function deleteBackup() {
    if (!deleteTarget) return;
    setBusy(true);
    const response = await fetch(`${basePath}/api/backups`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "delete", name: deleteTarget.name }) });
    if (response.ok) { setBackups((current) => current.filter((backup) => backup.name !== deleteTarget.name)); setNotice(`${deleteTarget.name} を削除しました`); await loadBackups(); } else setNotice("バックアップを削除できませんでした");
    setDeleteTarget(null);
    setBusy(false);
  }

  const storageTotal = Math.max(storage.totalBytes, 1);
  const storagePercent = (value: number) => `${Math.min((value / storageTotal) * 100, 100)}%`;
  const formatSize = (bytes: number) => `${(bytes / (1024 ** 3)).toFixed(2)} GB`;

  async function createBackup() {
    setBusy(true);
    setNotice("ワールドを保存しています...");
    const response = await fetch(`${basePath}/api/backups`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "create" }) });
    if (response.ok) {
      setNotice("保存が完了しました。バックアップを作成しています...");
      await loadBackups();
      setNotice("バックアップを作成しました");
    } else setNotice("保存に失敗したため、バックアップは作成されませんでした");
    setBusy(false);
  }

  async function restoreBackup(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!restoreTarget || restoreName !== restoreTarget.name || !stopConfirmed) return;
    setBusy(true);
    setNotice("復元処理を開始しています...");
    const response = await fetch(`${basePath}/api/backups`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "restore", name: restoreTarget.name, stopConfirmed: true }) });
    setNotice(response.ok ? "復元処理が完了しました。サーバーは停止状態です" : "復元に失敗しました。自動起動は行っていません");
    setBusy(false);
    setRestoreTarget(null);
    setRestoreName("");
    setStopConfirmed(false);
  }

  return <div className="app-shell">
    <aside className={`sidebar ${mobileNav ? "is-open" : ""}`}><div className="sidebar-header"><div className="brand-mark"><TerminalSquare size={19} /> PALUI</div><button className="icon-button mobile-close" onClick={() => setMobileNav(false)} aria-label="メニューを閉じる"><X size={18} /></button></div><div className="server-selector"><span className="signal-dot" /><div><small>MANAGED SERVER</small><strong>palworld-server</strong></div></div><nav className="main-nav" aria-label="メインナビゲーション"><p className="nav-label">OPERATIONS</p>{navItems.map(({ label, icon: Icon, href, active }) => <a href={href === "#" ? "#" : `${basePath}${href}`} className={active ? "active" : ""} key={label} onClick={href === "#" ? (event) => event.preventDefault() : undefined}><Icon size={17} /> {label}{active && <span className="nav-pip" />}</a>)}</nav><div className="sidebar-footer"><div className="operator-avatar">OP</div><div><strong>operator</strong><small>運用者</small></div><button className="icon-button" aria-label="ログアウト" onClick={async () => { await fetch(`${basePath}/api/auth/logout`, { method: "POST" }); window.location.href = `${basePath}/login`; }}><LogOut size={16} /></button></div></aside>
    <main className="content-area"><header className="topbar"><button className="icon-button menu-trigger" onClick={() => setMobileNav(true)} aria-label="メニューを開く"><Menu size={20} /></button><div className="breadcrumbs"><span>OPERATIONS</span><b>/</b><strong>バックアップ</strong></div><div className="topbar-meta"><span className="live-indicator"><i /> LIVE</span><span className="topbar-divider" /><span className="muted">17 Sep 2026, 14:32 JST</span></div></header><div className="page-content">
      <div className="page-heading"><div><p className="eyebrow">DATA PROTECTION / 03</p><h1>バックアップ</h1><p className="muted">ワールドデータの保存と、検証済みバックアップからの復元。</p></div><button className="secondary-button" onClick={loadBackups}><RefreshCw size={15} /> 再取得</button></div>
      <div className="notice-bar"><span className="notice-icon"><Check size={14} /></span><span>{notice}</span><button aria-label="通知を閉じる" onClick={() => setNotice("")}><X size={15} /></button></div>
      <section className="backup-summary panel"><div className="backup-summary-top"><div className="backup-summary-icon"><Archive size={22} /></div><div><p className="eyebrow">STORAGE / {storage.source.toUpperCase()}</p><h2>現在のストレージ</h2><p className="muted">/server/palworld の使用状況</p></div><div className="backup-summary-stats"><span>総容量<strong>{formatSize(storage.totalBytes)}</strong></span><span>バックアップ<strong>{formatSize(storage.backupBytes)}</strong></span><span>空き容量<strong>{formatSize(storage.freeBytes)}</strong></span></div></div><hr className="backup-summary-divider" /><div className="storage-panel"><div className="storage-bar" aria-label="ストレージ使用量"><span className="storage-segment system" style={{ width: storagePercent(storage.systemBytes) }} /><span className="storage-segment backup" style={{ width: storagePercent(storage.backupBytes) }} /><span className="storage-segment free" style={{ width: storagePercent(storage.freeBytes) }} /></div><div className="storage-legend"><span><i className="system" />システム使用量 <strong>{formatSize(storage.systemBytes)}</strong></span><span><i className="backup" />バックアップ使用量 <strong>{formatSize(storage.backupBytes)}</strong></span><span><i className="free" />空き容量 <strong>{formatSize(storage.freeBytes)}</strong></span></div></div></section>
      <section className="panel backup-list-panel"><div className="panel-heading"><div><p className="eyebrow">ARCHIVES / {backups.length}</p><h3>バックアップ一覧</h3></div><button className="primary-button" onClick={createBackup} disabled={busy}><Save size={15} /> {busy ? "処理中..." : "今すぐバックアップ"}</button></div><div className="backup-table-wrap"><table className="backup-table"><thead><tr><th>ファイル名</th><th>作成日時</th><th>サイズ</th><th>整合性</th><th><span className="sr-only">操作</span></th></tr></thead><tbody>{backups.map((backup) => <tr key={backup.name}><td><div className="backup-name"><Archive size={16} /><strong>{backup.name}</strong></div></td><td>{new Date(backup.createdAt).toLocaleString("ja-JP")}</td><td>{backup.size}</td><td><span className={`status-badge ${backup.integrity === "検証済み" ? "success" : "warning"}`}><FileCheck size={12} /> {backup.integrity}</span></td><td><div className="backup-actions"><button className="secondary-button" onClick={() => { setRestoreTarget(backup); setRestoreName(""); setStopConfirmed(false); }}><RotateCcw size={14} /> 復元</button><button className="icon-button delete-backup-button" onClick={() => setDeleteTarget(backup)} aria-label={`${backup.name} を削除`}><Trash2 size={15} /></button></div></td></tr>)}</tbody></table></div></section>
      <section className="backup-warning"><div><Save size={16} /><strong>作成前にワールドを保存します</strong><span>save が失敗した場合、明示的な承認なしにバックアップ処理は続行されません。</span></div><span className="status-badge success">SAFE FLOW</span></section>
    </div></main>
    {restoreTarget && <div className="dialog-backdrop" onClick={() => setRestoreTarget(null)}><section className="confirm-dialog restore-dialog" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}><div className="dialog-icon"><RotateCcw size={20} /></div><p className="eyebrow">RESTORE / IMPACT</p><h2>バックアップを復元</h2><p className="muted">対象: <strong>{restoreTarget.name}</strong><br />サーバーを停止し、現在のワールドデータを置き換えます。復元後は自動起動しません。</p><form onSubmit={restoreBackup}><label className="restore-check"><input type="checkbox" checked={stopConfirmed} onChange={(event) => setStopConfirmed(event.target.checked)} /> サーバーを停止して復元することを確認しました</label><label className="restore-name-label">確認のためファイル名を入力<input value={restoreName} onChange={(event) => setRestoreName(event.target.value)} placeholder={restoreTarget.name} required /></label><div className="dialog-actions"><button type="button" className="secondary-button" onClick={() => setRestoreTarget(null)}>キャンセル</button><button type="submit" className="primary-button destructive-button" disabled={busy || restoreName !== restoreTarget.name || !stopConfirmed}>復元を実行</button></div></form></section></div>}
    {deleteTarget && <div className="dialog-backdrop" onClick={() => setDeleteTarget(null)}><section className="confirm-dialog" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}><div className="dialog-icon"><Trash2 size={20} /></div><p className="eyebrow">DELETE ARCHIVE</p><h2>バックアップを削除</h2><p className="muted">対象: <strong>{deleteTarget.name}</strong><br />このバックアップファイルを削除します。復元できなくなります。</p><div className="dialog-actions"><button className="secondary-button" onClick={() => setDeleteTarget(null)}>キャンセル</button><button className="primary-button destructive-button" onClick={deleteBackup} disabled={busy}>削除する</button></div></section></div>}
  </div>;
}