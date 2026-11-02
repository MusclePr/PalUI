"use client";

import { Ban, Copy, MoreHorizontal, Trash2, X } from "lucide-react";
import { memo } from "react";
import type { PlayerRow } from "./player-rows";

type Props = PlayerRow & {
  menuOpen: boolean;
  onToggleMenu: (rowKey: string) => void;
  onCopyId: (userId: string) => void;
  onToggleWhitelist: (userId: string, enabled: boolean) => Promise<void>;
  onDelete: (player: PlayerRow) => void;
};

export const PlayerTableRow = memo(function PlayerTableRow({ menuOpen, onToggleMenu, onCopyId, onToggleWhitelist, onDelete, ...player }: Props) {
  return (
    <tr>
      <td><div className="player-name" title={`ゲーム内名: ${player.gameName || "--"}\nアカウント名: ${player.accountName || "--"}\nゲーム内ID: ${player.playerId || "--"}\nユーザーID: ${player.userId || "--"}\nIPアドレス: ${player.ip || "--"}\nPING: ${player.ping || "--"} ms\n建築数: ${player.buildingCount || "--"}`}><span className="player-avatar">{player.name.slice(0, 1)}</span><strong>{player.name}</strong>{player.gameName && player.gameName !== player.name && <small className="muted">（ゲーム内名: {player.gameName}）</small>}{player.banned && <span className="banned-indicator" title="BAN 済み"><X size={13} /></span>}</div></td>
      <td><span className={`status-badge ${player.online ? "success" : "offline"}`}><i /> {player.online ? "オンライン" : "オフライン"}</span></td>
      <td><label className="table-check"><input type="checkbox" checked={player.whitelisted} disabled={!player.userId} onChange={(event) => { void onToggleWhitelist(player.userId, event.target.checked); }} /><span>{player.whitelisted ? "登録済み" : "未登録"}</span></label></td>
      <td>Lv. {player.level || "--"}</td>
      <td>{player.lastLogin ? new Date(player.lastLogin).toLocaleString("ja-JP") : "--"}</td>
      <td><div className="player-menu"><button className="icon-button" aria-label={`${player.name} の操作メニュー`} aria-expanded={menuOpen} onClick={() => onToggleMenu(player.rowKey)}><MoreHorizontal size={18} /></button>{menuOpen && <div className="dropdown-menu"><button disabled={!player.userId} onClick={() => onCopyId(player.userId)}><Copy size={14} /> ユーザーIDのコピー</button><button disabled title="BAN / UNBAN 操作は未実装です"><Ban size={14} /> {player.banned ? "UNBAN" : "BAN"}</button><button className="danger-menu-item" disabled={!player.userId} onClick={() => onDelete(player)}><Trash2 size={14} /> 削除</button></div>}</div></td>
    </tr>
  );
});
