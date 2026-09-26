"use client";

import {
  Ban, Bell, Check, Copy, Database, LayoutDashboard,
  Menu, MessageSquare, MoreHorizontal, Search, Settings, Shield, TerminalSquare,
  Trash2, UserCheck, UserPlus, UserSearch, Users, X,
} from "lucide-react";
import { createPortal } from "react-dom";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { SidebarFooter } from "../components/SidebarFooter";

type Player = {
  name: string;
  playerId: string;
  userId: string;
  ip: string;
  ping: number;
  buildingCount: number;
  level: number;
  lastLogin: string | null;
  banned: boolean;
};

type RegisteredPlayer = {
  id: string;
  displayName: string;
  role: string;
  white: boolean;
  banned: boolean;
  level: number;
  lastLogin: string | null;
  firstLogin: string | null;
};

type DetectedPlayer = {
  id: string;
  displayName: string;
  lastLogin: string | null;
};

type DetectDialogState = {
  loading: boolean;
  submitting: boolean;
  error: string;
  entries: DetectedPlayer[];
  checked: Set<string>;
  names: Record<string, string>;
};

// whitelist.sh の IsVaridID / IsValidName と同じ規則
const detectedIdPattern = /^[a-z0-9]+_[0-9]+$/;
const forbiddenNameChars = /["'\\`$&|;<>]/;

const navItems = [
  { label: "ダッシュボード", icon: LayoutDashboard, href: "/dashboard" },
  { label: "プレイヤー", icon: Users, href: "/players", active: true },
  { label: "バックアップ", icon: Database, href: "/backups" },
  { label: "設定", icon: Settings, href: "/settings" },
];

const basePath = process.env.NEXT_PUBLIC_BASE_PATH || "/palui";

function displayPlayerName(onlinePlayer: Player | undefined, registeredPlayer: RegisteredPlayer | undefined, playerId: string) {
  return onlinePlayer?.name?.trim() || registeredPlayer?.displayName?.trim() || playerId;
}

export default function PlayersPage() {
  const [mobileNav, setMobileNav] = useState(false);
  const [notice, setNotice] = useState("players.json を読み込み中です");
  const [announce, setAnnounce] = useState("");
  const [players, setPlayers] = useState<Player[]>([]);
  const [registeredPlayers, setRegisteredPlayers] = useState<RegisteredPlayer[]>([]);
  const [whitelist, setWhitelist] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [registration, setRegistration] = useState({ name: "", playerId: "", enabled: true });
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [menuPosition, setMenuPosition] = useState<{ left: number; top: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [confirmAction, setConfirmAction] = useState<{ type: "ban" | "delete"; playerId: string; playerName: string; banned: boolean } | null>(null);
  const [detectDialog, setDetectDialog] = useState<DetectDialogState | null>(null);

  function applyPlayersPayload(data: { onlinePlayers?: Player[]; registeredPlayers?: RegisteredPlayer[]; whitelist?: string[] }) {
    if (Array.isArray(data.onlinePlayers)) {
      // players REST 応答に BAN 情報がない間も、画面で保持している状態を失わない。
      setPlayers((current) => data.onlinePlayers!.map((player) => ({
        ...player,
        banned: player.banned || current.find((item) => item.playerId === player.playerId)?.banned === true,
      })));
    }
    if (Array.isArray(data.registeredPlayers)) setRegisteredPlayers(data.registeredPlayers);
    if (Array.isArray(data.whitelist)) setWhitelist(data.whitelist);
  }

  async function readApiMessage(response: Response, fallback: string) {
    const data = await response.json().catch(() => null) as { error?: unknown } | null;
    return typeof data?.error === "string" ? data.error : fallback;
  }

  useEffect(() => {
    if (!openMenu) return;

    function closeMenu(event: MouseEvent) {
      const target = event.target;
      if (target instanceof Element && !target.closest(".player-menu, .dropdown-menu")) setOpenMenu(null);
    }

    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setOpenMenu(null);
    }

    document.addEventListener("mousedown", closeMenu);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeMenu);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [openMenu]);

  useLayoutEffect(() => {
    if (!openMenu) return;

    function updateMenuPosition() {
      const anchor = document.querySelector<HTMLButtonElement>('.player-menu button[aria-expanded="true"]');
      const menu = menuRef.current;
      if (!anchor || !menu) return;

      const anchorRect = anchor.getBoundingClientRect();
      const menuRect = menu.getBoundingClientRect();
      const margin = 8;
      const gap = 4;
      const left = Math.max(margin, Math.min(anchorRect.right - menuRect.width, window.innerWidth - menuRect.width - margin));
      let top = anchorRect.bottom + gap;
      if (top + menuRect.height > window.innerHeight - margin) top = anchorRect.top - menuRect.height - gap;
      top = Math.max(margin, Math.min(top, window.innerHeight - menuRect.height - margin));
      setMenuPosition({ left, top });
    }

    updateMenuPosition();
    window.addEventListener("resize", updateMenuPosition);
    window.addEventListener("scroll", updateMenuPosition, true);
    return () => {
      window.removeEventListener("resize", updateMenuPosition);
      window.removeEventListener("scroll", updateMenuPosition, true);
    };
  }, [openMenu]);

  useEffect(() => {
    fetch(`${basePath}/api/players`)
      .then(async (response) => {
        if (!response.ok) throw new Error(await readApiMessage(response, `players.json を読み込めませんでした (${response.status})`));
        return await response.json();
      })
      .then((data: { onlinePlayers?: Player[]; registeredPlayers?: RegisteredPlayer[]; whitelist?: string[] }) => {
        applyPlayersPayload(data);
        setNotice(`players.json から ${Array.isArray(data.registeredPlayers) ? data.registeredPlayers.length : 0} 件を読み込みました`);
      })
      .catch((error) => setNotice(error instanceof Error ? error.message : "players.json を読み込めませんでした"));
  }, []);

  const rows = useMemo(() => {
    const known = new Map(players.map((player) => [player.playerId, player]));
    const registered = new Map(registeredPlayers.map((player) => [player.id, player]));
    return [...new Set([...players.map((player) => player.playerId), ...registeredPlayers.map((player) => player.id), ...whitelist])].map((playerId) => {
      const onlinePlayer = known.get(playerId);
      const registeredPlayer = registered.get(playerId);
      const name = displayPlayerName(onlinePlayer, registeredPlayer, playerId);
      return {
      ...(onlinePlayer ?? { name, playerId, userId: "", ip: "", ping: 0, buildingCount: 0, level: registeredPlayer?.level ?? 0, lastLogin: registeredPlayer?.lastLogin ?? null, banned: registeredPlayer?.banned === true }),
      name,
      level: onlinePlayer?.level || registeredPlayer?.level || 0,
      lastLogin: onlinePlayer?.lastLogin ?? registeredPlayer?.lastLogin ?? null,
      banned: onlinePlayer?.banned === true || registeredPlayer?.banned === true,
      role: registeredPlayer?.role ?? "--",
      online: known.has(playerId),
      whitelisted: whitelist.includes(playerId) || registeredPlayer?.white === true,
      };
    }).filter((player) => `${player.name} ${player.playerId}`.toLowerCase().includes(search.toLowerCase()));
  }, [players, registeredPlayers, search, whitelist]);

  const menuPlayer = rows.find((player) => player.playerId === openMenu);

  function copyPlayerId(id: string) {
    navigator.clipboard?.writeText(id);
    setNotice("プレイヤーIDをコピーしました");
  }

  function sendAnnounce(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!announce.trim()) return;
    setNotice(`告知を送信しました: ${announce}`);
    setAnnounce("");
  }

  async function registerPlayer(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!registration.name.trim() || !registration.playerId.trim()) return;
    const response = await fetch(`${basePath}/api/players`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "add", displayName: registration.name.trim(), playerId: registration.playerId.trim(), enabled: registration.enabled }) });
    if (response.ok) {
      const data = await response.json();
      applyPlayersPayload(data);
      setNotice(`${registration.name} を登録しました`);
      setRegistration({ name: "", playerId: "", enabled: true });
    } else setNotice(await readApiMessage(response, "プレイヤーを登録できませんでした"));
  }

  async function toggleWhitelist(playerId: string, enabled: boolean) {
    const response = await fetch(`${basePath}/api/players`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "whitelist", playerId, enabled }) });
    if (response.ok) {
      applyPlayersPayload(await response.json());
      setNotice(`ホワイトリストを${enabled ? "有効" : "無効"}にしました`);
    } else setNotice(await readApiMessage(response, "ホワイトリストを更新できませんでした"));
  }

  async function openDetectDialog() {
    setDetectDialog({ loading: true, submitting: false, error: "", entries: [], checked: new Set(), names: {} });
    try {
      const response = await fetch(`${basePath}/api/players`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "detect" }) });
      if (!response.ok) throw new Error(await readApiMessage(response, "未登録プレイヤーを検出できませんでした"));
      const data = await response.json() as { detected?: DetectedPlayer[] };
      const entries = Array.isArray(data.detected) ? data.detected : [];
      setDetectDialog((current) => current && { ...current, loading: false, entries, names: Object.fromEntries(entries.map((entry) => [entry.id, entry.displayName])) });
    } catch (error) {
      setDetectDialog((current) => current && { ...current, loading: false, error: error instanceof Error ? error.message : "未登録プレイヤーを検出できませんでした" });
    }
  }

  function toggleDetected(id: string, checked: boolean) {
    setDetectDialog((current) => {
      if (!current) return current;
      const next = new Set(current.checked);
      if (checked) next.add(id); else next.delete(id);
      return { ...current, checked: next };
    });
  }

  async function registerDetected() {
    if (!detectDialog || detectDialog.checked.size === 0) return;
    const players = detectDialog.entries.filter((entry) => detectDialog.checked.has(entry.id)).map((entry) => ({ playerId: entry.id, displayName: detectDialog.names[entry.id]?.trim() || entry.id }));
    setDetectDialog({ ...detectDialog, submitting: true, error: "" });
    const response = await fetch(`${basePath}/api/players`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "register-detected", players }) });
    if (!response.ok) {
      const message = await readApiMessage(response, "ホワイトリストに登録できませんでした");
      setDetectDialog((current) => current && { ...current, submitting: false, error: message });
      return;
    }
    const data = await response.json() as Parameters<typeof applyPlayersPayload>[0] & { results?: { playerId: string; ok: boolean; reason?: string }[] };
    applyPlayersPayload(data);
    const results = Array.isArray(data.results) ? data.results : [];
    const failed = results.filter((result) => !result.ok);
    const succeeded = results.length - failed.length;
    setNotice(failed.length === 0
      ? `${succeeded} 件をホワイトリストに登録しました`
      : `${succeeded} 件を登録、${failed.length} 件失敗しました: ${failed.map((result) => `${result.playerId} (${result.reason ?? "error"})`).join(", ")}`);
    setDetectDialog(null);
  }

  const detectSelectable = detectDialog?.entries.filter((entry) => detectedIdPattern.test(entry.id)) ?? [];
  const detectHasInvalidName = detectDialog ? [...detectDialog.checked].some((id) => forbiddenNameChars.test(detectDialog.names[id] ?? "")) : false;

  async function confirmPlayerAction() {
    if (!confirmAction) return;
    if (confirmAction.type === "delete") {
      const response = await fetch(`${basePath}/api/players`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "delete", playerId: confirmAction.playerId }) });
      if (response.ok) {
        applyPlayersPayload(await response.json());
        setNotice(`${confirmAction.playerName} を players.json とホワイトリストから削除しました`);
      } else {
        setNotice(await readApiMessage(response, "プレイヤーを削除できませんでした"));
      }
    } else {
      setPlayers((current) => current.map((player) => player.playerId === confirmAction.playerId ? { ...player, banned: !confirmAction.banned } : player));
      setNotice(`${confirmAction.playerName} を${confirmAction.banned ? "UNBAN" : "BAN"}しました`);
    }
    setOpenMenu(null);
    setConfirmAction(null);
  }

  return (
    <div className="app-shell">
      <aside className={`sidebar ${mobileNav ? "is-open" : ""}`}>
        <div className="sidebar-header"><div className="brand-mark"><TerminalSquare size={19} /> PALUI</div><button className="icon-button mobile-close" onClick={() => setMobileNav(false)} aria-label="メニューを閉じる"><X size={18} /></button></div>
        <div className="server-selector"><span className="signal-dot" /><div><small>MANAGED SERVER</small><strong>palworld-server</strong></div></div>
        <nav className="main-nav" aria-label="メインナビゲーション"><p className="nav-label">OPERATIONS</p>{navItems.map(({ label, icon: Icon, href, active }) => <a href={href === "#" ? "#" : `${basePath}${href}`} className={active ? "active" : ""} key={label} onClick={href === "#" ? (event) => event.preventDefault() : undefined}><Icon size={17} /> {label}{active && <span className="nav-pip" />}</a>)}</nav>
        <SidebarFooter />
      </aside>
        {openMenu && menuPlayer && createPortal(
          <div
            ref={menuRef}
            className="dropdown-menu dropdown-menu-portal"
            role="menu"
            aria-label={`${menuPlayer.name} の操作`}
            style={{ left: menuPosition?.left ?? -10000, top: menuPosition?.top ?? 0, visibility: menuPosition ? "visible" : "hidden" }}
          >
            <button onClick={() => { copyPlayerId(menuPlayer.playerId); setOpenMenu(null); }}><Copy size={14} /> プレイヤーIDのコピー</button>
            <button onClick={() => { setOpenMenu(null); setConfirmAction({ type: "ban", playerId: menuPlayer.playerId, playerName: menuPlayer.name, banned: menuPlayer.banned }); }}><Ban size={14} /> {menuPlayer.banned ? "UNBAN" : "BAN"}</button>
            <button className="danger-menu-item" onClick={() => { setOpenMenu(null); setConfirmAction({ type: "delete", playerId: menuPlayer.playerId, playerName: menuPlayer.name, banned: menuPlayer.banned }); }}><Trash2 size={14} /> 削除</button>
          </div>,
          document.body
        )}
        <main className="content-area">
        <header className="topbar"><button className="icon-button menu-trigger" onClick={() => setMobileNav(true)} aria-label="メニューを開く"><Menu size={20} /></button><div className="breadcrumbs"><span>OPERATIONS</span><b>/</b><strong>プレイヤー</strong></div><div className="topbar-meta"><span className="live-indicator"><i /> LIVE</span><span className="topbar-divider" /><span className="muted">17 Sep 2026, 14:32 JST</span></div></header>
        <div className="page-content">
          <div className="page-heading"><div><p className="eyebrow">PLAYER MANAGEMENT / 02</p><h1>プレイヤー</h1><p className="muted">オンライン・オフライン・ホワイトリストを統合して表示します。</p></div><span className="status-badge success"><Check size={13} /> サーバー接続中</span></div>
          <div className="notice-bar"><span className="notice-icon"><Check size={14} /></span><span>{notice}</span><button aria-label="通知を閉じる" onClick={() => setNotice("")}><X size={15} /></button></div>
          <section className="player-toolbar panel"><form className="announce-form" onSubmit={sendAnnounce}><MessageSquare size={16} /><input aria-label="全体告知" value={announce} onChange={(event) => setAnnounce(event.target.value)} placeholder="全体に告知を送信..." /><button className="secondary-button" type="submit"><Bell size={15} /> 告知</button></form><div className="search-box"><Search size={15} /><input aria-label="プレイヤーを検索" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="検索" /></div></section>
          <section className="panel player-panel"><div className="panel-heading"><div><p className="eyebrow">MIXED LIST / {rows.length}</p><h3>プレイヤー一覧</h3></div><span className="panel-status"><i /> CACHE ENABLED</span></div><div className="player-table-wrap"><table className="player-table"><thead><tr><th>プレイヤー名</th><th>オンライン</th><th>ホワイトリスト</th><th>レベル</th><th>最終ログイン</th><th><span className="sr-only">操作</span></th></tr></thead><tbody>{rows.map((player) => <tr key={player.playerId}><td><div className="player-name" title={`アカウント名: ${player.name}\nプレイヤーID: ${player.playerId}\nユーザーID: ${player.userId || "--"}\nIPアドレス: ${player.ip || "--"}\nPING: ${player.ping || "--"} ms\n建築数: ${player.buildingCount || "--"}`}><span className="player-avatar">{player.name.slice(0, 1)}</span><strong>{player.name}</strong>{player.banned && <span className="banned-indicator" title="BAN 済み"><X size={13} /></span>}</div></td><td><span className={`status-badge ${player.online ? "success" : "offline"}`}><i /> {player.online ? "オンライン" : "オフライン"}</span></td><td><label className="table-check"><input type="checkbox" checked={player.whitelisted} onChange={(event) => toggleWhitelist(player.playerId, event.target.checked)} /><span>{player.whitelisted ? "登録済み" : "未登録"}</span></label></td><td>Lv. {player.level || "--"}</td><td>{player.lastLogin ? new Date(player.lastLogin).toLocaleString("ja-JP") : "--"}</td><td><div className="player-menu"><button className="icon-button" aria-label={`${player.name} の操作メニュー`} aria-expanded={openMenu === player.playerId} onClick={() => setOpenMenu(openMenu === player.playerId ? null : player.playerId)}><MoreHorizontal size={18} /></button>{openMenu === player.playerId && <div className="dropdown-menu"><button onClick={() => copyPlayerId(player.playerId)}><Copy size={14} /> プレイヤーIDのコピー</button><button onClick={() => setConfirmAction({ type: "ban", playerId: player.playerId, playerName: player.name, banned: player.banned })}><Ban size={14} /> {player.banned ? "UNBAN" : "BAN"}</button><button className="danger-menu-item" onClick={() => setConfirmAction({ type: "delete", playerId: player.playerId, playerName: player.name, banned: player.banned })}><Trash2 size={14} /> 削除</button></div>}</div></td></tr>)}</tbody></table></div></section>
          <section className="player-lower-grid"><div className="panel whitelist-panel"><div className="panel-heading"><div><p className="eyebrow">PLAYER REGISTRATION</p><h3>プレイヤー登録</h3></div><UserPlus size={18} className="muted-icon" /></div><form className="registration-form" onSubmit={registerPlayer}><label>名前<input value={registration.name} onChange={(event) => setRegistration({ ...registration, name: event.target.value })} placeholder="Sakura_A" required /></label><label>プレイヤーID<input value={registration.playerId} onChange={(event) => setRegistration({ ...registration, playerId: event.target.value })} placeholder="steam_76561198847285114" pattern="[-_a-zA-Z0-9:.]+" required /></label><label className="registration-check"><input type="checkbox" checked={registration.enabled} onChange={(event) => setRegistration({ ...registration, enabled: event.target.checked })} /> ホワイトリストに登録</label><div className="registration-actions"><button className="primary-button" type="submit" disabled={!registration.name.trim() || !registration.playerId.trim()}><UserPlus size={15} /> 登録する</button><button className="secondary-button detect-button" type="button" onClick={openDetectDialog}><UserSearch size={15} /> 未登録プレイヤーの検出</button></div></form></div><div className="panel moderation-panel"><div className="panel-heading"><div><p className="eyebrow">RCON / ACCESS CONTROL</p><h3>ホワイトリスト状態</h3></div><Shield size={18} className="muted-icon" /></div><div className="capability-state"><UserCheck size={18} /><div><strong>ファイル確認済み</strong><span>RCON 利用時はコマンドでリアルタイム反映</span></div><span className="status-badge success">AVAILABLE</span></div><p className="muted">RCON が利用できない場合は WhiteList.json を直接更新します。</p></div></section>
        </div>
      </main>
      {confirmAction && <div className="dialog-backdrop" role="presentation" onClick={() => setConfirmAction(null)}><section className="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="confirm-title" onClick={(event) => event.stopPropagation()}><div className="dialog-icon"><Ban size={20} /></div><p className="eyebrow">CONFIRM ACTION</p><h2 id="confirm-title">{confirmAction.type === "delete" ? "プレイヤーを削除" : confirmAction.banned ? "BANを解除" : "プレイヤーをBAN"}</h2><p className="muted">対象: <strong>{confirmAction.playerName}</strong><br />この操作を実行してよろしいですか。</p><div className="dialog-actions"><button className="secondary-button" onClick={() => setConfirmAction(null)}>キャンセル</button><button className="primary-button destructive-button" onClick={confirmPlayerAction}>{confirmAction.type === "delete" ? "削除する" : confirmAction.banned ? "UNBANする" : "BANする"}</button></div></section></div>}
      {detectDialog && (
        <div className="dialog-backdrop" role="presentation" onClick={() => !detectDialog.submitting && setDetectDialog(null)}>
          <section className="confirm-dialog detect-dialog" role="dialog" aria-modal="true" aria-labelledby="detect-title" onClick={(event) => event.stopPropagation()}>
            <p className="eyebrow">WHITELIST / DETECTION</p>
            <h2 id="detect-title">未登録プレイヤーの検出</h2>
            <p className="muted">接続を拒否されたプレイヤーをログから抽出しました。チェックしたプレイヤーをホワイトリストに登録します。</p>
            {detectDialog.error && <p className="detect-error">{detectDialog.error}</p>}
            {detectDialog.loading ? <p className="muted detect-empty">検出中...</p> : detectDialog.entries.length === 0 ? (!detectDialog.error && <p className="muted detect-empty">未登録のプレイヤーは見つかりませんでした</p>) : (
              <div className="player-table-wrap detect-table-wrap">
                <table className="player-table detect-table">
                  <thead><tr>
                    <th><input type="checkbox" aria-label="すべて選択" checked={detectSelectable.length > 0 && detectSelectable.every((entry) => detectDialog.checked.has(entry.id))} onChange={(event) => setDetectDialog({ ...detectDialog, checked: event.target.checked ? new Set(detectSelectable.map((entry) => entry.id)) : new Set() })} /></th>
                    <th>名前</th><th>プレイヤーID</th><th>最終ログイン</th>
                  </tr></thead>
                  <tbody>{detectDialog.entries.map((entry) => {
                    const validId = detectedIdPattern.test(entry.id);
                    const name = detectDialog.names[entry.id] ?? "";
                    const invalidName = forbiddenNameChars.test(name);
                    return (
                      <tr key={entry.id}>
                        <td><input type="checkbox" aria-label={`${entry.id} を選択`} disabled={!validId} checked={detectDialog.checked.has(entry.id)} onChange={(event) => toggleDetected(entry.id, event.target.checked)} /></td>
                        <td>
                          <input className="detect-name-input" aria-label={`${entry.id} の名前`} aria-invalid={invalidName} maxLength={64} value={name} placeholder={entry.id} onChange={(event) => setDetectDialog({ ...detectDialog, names: { ...detectDialog.names, [entry.id]: event.target.value } })} />
                          {invalidName && <small className="detect-error">使用できない文字が含まれています</small>}
                        </td>
                        <td><code>{entry.id}</code>{!validId && <small className="detect-error">不正なID</small>}</td>
                        <td>{entry.lastLogin ? new Date(entry.lastLogin).toLocaleString("ja-JP") : "--"}</td>
                      </tr>
                    );
                  })}</tbody>
                </table>
              </div>
            )}
            <div className="dialog-actions">
              <button className="secondary-button" disabled={detectDialog.submitting} onClick={() => setDetectDialog(null)}>閉じる</button>
              <button className="primary-button" disabled={detectDialog.loading || detectDialog.submitting || detectDialog.checked.size === 0 || detectHasInvalidName} onClick={registerDetected}><UserPlus size={15} /> {detectDialog.submitting ? "登録中..." : `${detectDialog.checked.size} 件を登録する`}</button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}