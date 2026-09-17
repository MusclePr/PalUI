"use client";

import { Check, Database, Eye, EyeOff, FileCog, LayoutDashboard, LogOut, Menu, Save, Settings, TerminalSquare, Users, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

type Setting = { key: string; value: string; defaultValue: string; overridden: boolean; secret: boolean; label: string; description: string; type: string; heading?: string; min?: number; max?: number; options?: string[] };
type Category = { category: string; values: Setting[] };
const basePath = process.env.NEXT_PUBLIC_BASE_PATH || "/palui";
const labels: Record<string, string> = { system: "システム", server: "サーバー", features: "ゲーム機能", balance: "ゲームバランス", performance: "パフォーマンス" };
const navItems = [{ label: "ダッシュボード", icon: LayoutDashboard, href: "/dashboard" }, { label: "プレイヤー", icon: Users, href: "/players" }, { label: "バックアップ", icon: Database, href: "/backups" }, { label: "設定", icon: Settings, href: "/settings", active: true }];

function selectedValues(value: string) { return value.trim().replace(/^"|"$/g, "").replace(/^\(|\)$/g, "").split(",").map((item) => item.trim()).filter(Boolean); }
function valuesEqual(setting: Setting, left: string, right: string) {
  if (setting.type === "BOOL") return left.toLowerCase() === right.toLowerCase();
  if (setting.type === "SELECT" || setting.type === "ARRAY") return [...new Set(selectedValues(left))].sort().join(",") === [...new Set(selectedValues(right))].sort().join(",");
  return left === right;
}

export default function SettingsPage() {
  const [mobileNav, setMobileNav] = useState(false);
  const [categories, setCategories] = useState<Category[]>([]);
  const [activeCategory, setActiveCategory] = useState("system");
  const [hash, setHash] = useState("");
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
  const [notice, setNotice] = useState("設定ファイルを読み込んでいます...");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch(`${basePath}/api/settings`).then((response) => response.json()).then((data) => {
      setCategories(data.categories ?? []);
      setHash(data.hash ?? "");
      setNotice("設定は最新です");
    }).catch(() => setNotice("設定を読み込めませんでした"));
  }, []);

  const active = categories.find((category) => category.category === activeCategory);
  const changed = useMemo(() => categories.flatMap((category) => category.values).filter((setting) => draft[setting.key] !== undefined && !valuesEqual(setting, draft[setting.key], setting.value)), [categories, draft]);

  function updateSetting(key: string, value: string) {
    setDraft((current) => ({ ...current, [key]: value }));
    setNotice("未保存の変更があります");
  }

  async function save() {
    setBusy(true);
    const values = Object.fromEntries(categories.flatMap((category) => category.values).map((setting) => [setting.key, draft[setting.key] ?? setting.value]));
    const response = await fetch(`${basePath}/api/settings`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ values, expectedHash: hash }) });
    const data = await response.json();
    if (response.ok) { setCategories(data.categories); setHash(data.hash); setDraft({}); setNotice("保存しました。再起動または再作成後に反映されます"); } else setNotice(data.error ?? "保存に失敗しました");
    setBusy(false);
  }

  function renderInput(setting: Setting, value: string) {
    if (setting.type === "BOOL") return <label className="setting-switch" htmlFor={`setting-${setting.key}`}><input id={`setting-${setting.key}`} type="checkbox" checked={value.toLowerCase() === "true"} onChange={(event) => updateSetting(setting.key, String(event.target.checked))} /><span aria-hidden="true" /></label>;
    if (setting.type === "CHOICE") return <select value={value} onChange={(event) => updateSetting(setting.key, event.target.value)}>{setting.options?.map((option) => <option key={option} value={option}>{option}</option>)}</select>;
    if (setting.type === "SELECT") return <div className="setting-options">{setting.options?.map((option) => { const inputId = `setting-${setting.key}-${option}`; return <label key={option} htmlFor={inputId}><input id={inputId} type="checkbox" checked={selectedValues(value).includes(option)} onChange={(event) => { const values = selectedValues(value).filter((item) => item !== option); if (event.target.checked) values.push(option); updateSetting(setting.key, `(${values.join(",")})`); }} /> {option}</label>; })}</div>;
    const inputType = setting.type === "PASSWORD" && !revealed[setting.key] ? "password" : setting.type === "INT" || setting.type === "FLOAT" ? "number" : "text";
    return <><input type={inputType} min={setting.min} max={setting.max} step={setting.type === "FLOAT" ? "any" : undefined} value={setting.type === "ARRAY" ? selectedValues(value).join(",") : value} onChange={(event) => updateSetting(setting.key, setting.type === "ARRAY" ? `(${event.target.value.split(",").map((item) => item.trim()).filter(Boolean).join(",")})` : event.target.value)} />{setting.secret && <button type="button" className="icon-button" onClick={() => setRevealed((current) => ({ ...current, [setting.key]: !revealed[setting.key] }))} aria-label="秘密値の表示切替">{revealed[setting.key] ? <EyeOff size={15} /> : <Eye size={15} />}</button>}</>;
  }

  function renderSetting(setting: Setting) {
    const value = draft[setting.key] ?? setting.value;
    const isChanged = !valuesEqual(setting, value, setting.value);
    return <div key={setting.key} className={`setting-row ${isChanged ? "is-changed" : ""}`}><span><strong>{setting.label || setting.key}</strong><small>{setting.description || (isChanged ? `既定値: ${setting.defaultValue}` : "既定値")}</small></span><div className={`setting-input setting-type-${setting.type.toLowerCase()}`}>{renderInput(setting, value)}</div></div>;
  }

  function renderGroups(settings: Setting[]) {
    const groups: Array<{ heading: string; settings: Setting[] }> = [];
    for (const setting of settings) {
      const heading = setting.heading || "その他";
      const current = groups[groups.length - 1];
      if (!current || current.heading !== heading) groups.push({ heading, settings: [setting] });
      else current.settings.push(setting);
    }
    return groups.map((group) => <fieldset className="settings-group" key={group.heading}><legend>{group.heading}</legend>{group.settings.map(renderSetting)}</fieldset>);
  }

  return <div className="app-shell"><aside className={`sidebar ${mobileNav ? "is-open" : ""}`}><div className="sidebar-header"><div className="brand-mark"><TerminalSquare size={19} /> PALUI</div><button className="icon-button mobile-close" onClick={() => setMobileNav(false)} aria-label="メニューを閉じる"><X size={18} /></button></div><div className="server-selector"><span className="signal-dot" /><div><small>MANAGED SERVER</small><strong>palworld-server</strong></div></div><nav className="main-nav" aria-label="メインナビゲーション"><p className="nav-label">OPERATIONS</p>{navItems.map(({ label, icon: Icon, href, active }) => <a href={`${basePath}${href}`} className={active ? "active" : ""} key={label}><Icon size={17} /> {label}{active && <span className="nav-pip" />}</a>)}</nav><div className="sidebar-footer"><div className="operator-avatar">OP</div><div><strong>operator</strong><small>運用者</small></div><button className="icon-button" aria-label="ログアウト"><LogOut size={16} /></button></div></aside><main className="content-area"><header className="topbar"><button className="icon-button menu-trigger" onClick={() => setMobileNav(true)} aria-label="メニューを開く"><Menu size={20} /></button><div className="breadcrumbs"><span>OPERATIONS</span><b>/</b><strong>設定</strong></div><div className="topbar-meta"><span className="live-indicator"><i /> LIVE</span><span className="topbar-divider" /><span className="muted">17 Sep 2026, 14:32 JST</span></div></header><div className="page-content"><div className="page-heading"><div><p className="eyebrow">CONFIGURATION / 04</p><h1>設定</h1><p className="muted">コメント定義に基づく動的フォーム。変更値は override.env に集約します。</p></div><button className="primary-button" onClick={save} disabled={busy || changed.length === 0}><Save size={15} /> {busy ? "保存中..." : "変更を保存"}</button></div><div className={`notice-bar ${changed.length ? "notice-warning" : ""}`}><span className="notice-icon">{changed.length ? <FileCog size={14} /> : <Check size={14} />}</span><span>{notice}</span></div><section className="settings-layout panel"><div className="settings-tabs" role="tablist">{categories.map((category) => { const hasChanges = category.values.some((setting) => draft[setting.key] !== undefined && !valuesEqual(setting, draft[setting.key], setting.value)); return <button key={category.category} className={activeCategory === category.category ? "active" : ""} onClick={() => setActiveCategory(category.category)} role="tab">{labels[category.category] ?? category.category}{hasChanges && <span className="settings-tab-indicator" aria-label="未保存の変更あり" />}</button>; })}</div><div className="settings-form">{active && renderGroups(active.values)}</div></section><div className="settings-footer"><span><Check size={14} /> compose.yml は変更しません</span><span>override.env · {changed.length} 件の変更</span></div></div></main></div>;
}
