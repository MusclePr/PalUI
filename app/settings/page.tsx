"use client";

import { Check, ChevronDown, ChevronRight, Database, Eye, EyeOff, FileCog, LayoutDashboard, Menu, RotateCcw, Save, Settings, TerminalSquare, Users, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { SidebarFooter } from "../components/SidebarFooter";
import { ServerStatusIndicator } from "../components/ServerStatusIndicator";

type Setting = { key: string; value: string; defaultValue: string; overridden: boolean; secret: boolean; label: string; description: string; type: string; heading?: string; collapsible?: boolean; section?: number; min?: number; max?: number; options?: string[] };
type Category = { category: string; values: Setting[] };
type SettingGroup = { heading: string; collapsible: boolean; section?: number; settings: Setting[] };
const basePath = process.env.NEXT_PUBLIC_BASE_PATH || "/palui";
const labels: Record<string, string> = { compose: ".env 設定", system: "システム", server: "サーバー", features: "ゲーム機能", balance: "ゲームバランス", performance: "パフォーマンス" };
const navItems = [{ label: "ダッシュボード", icon: LayoutDashboard, href: "/dashboard" }, { label: "プレイヤー", icon: Users, href: "/players" }, { label: "バックアップ", icon: Database, href: "/backups" }, { label: "設定", icon: Settings, href: "/settings", active: true }];

function selectedValues(value: string) { return value.trim().replace(/^"|"$/g, "").replace(/^\(|\)$/g, "").split(",").map((item) => item.trim()).filter(Boolean); }
function valuesEqual(setting: Setting, left: string, right: string) {
  if (setting.type === "BOOL") return left.toLowerCase() === right.toLowerCase();
  if (setting.type === "SELECT" || setting.type === "ARRAY") return [...new Set(selectedValues(left))].sort().join(",") === [...new Set(selectedValues(right))].sort().join(",");
  return left === right;
}
function groupSettings(settings: Setting[]) {
  const groups: SettingGroup[] = [];
  for (const setting of settings) {
    const heading = setting.heading || "その他";
    const collapsible = setting.collapsible === true;
    const current = groups[groups.length - 1];
    if (!current || current.heading !== heading || current.collapsible !== collapsible || current.section !== setting.section) groups.push({ heading, collapsible, section: setting.section, settings: [setting] });
    else current.settings.push(setting);
  }
  return groups;
}
function sectionKey(category: string, group: SettingGroup, index: number) { return `${category}:${group.section ?? index}:${group.heading}`; }

export default function SettingsPage() {
  const [mobileNav, setMobileNav] = useState(false);
  const [categories, setCategories] = useState<Category[]>([]);
  const [activeCategory, setActiveCategory] = useState("compose");
  const [hash, setHash] = useState("");
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({});
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
  const [notice, setNotice] = useState("設定ファイルを読み込んでいます...");
  const [busy, setBusy] = useState(false);
  const [pendingReset, setPendingReset] = useState<{ settings: Setting[]; label: string } | null>(null);

  useEffect(() => {
    fetch(`${basePath}/api/settings`).then((response) => {
      if (!response.ok) throw new Error("設定を読み込めませんでした");
      return response.json();
    }).then((data) => {
      const nextCategories: Category[] = data.categories ?? [];
      setCategories(nextCategories);
      setActiveCategory((current) => nextCategories.some((category) => category.category === current) ? current : nextCategories[0]?.category ?? "");
      setExpandedSections(Object.fromEntries(nextCategories.flatMap((category) => groupSettings(category.values).map((group, index) => [sectionKey(category.category, group, index), group.collapsible && group.settings.some((setting) => !valuesEqual(setting, setting.value, setting.defaultValue))]))));
      setHash(data.hash ?? "");
      setNotice("設定は最新です");
    }).catch(() => setNotice("設定を読み込めませんでした"));
  }, []);

  const active = categories.find((category) => category.category === activeCategory);
  const isAdmin = categories.some((category) => category.category === "compose");
  const settingsDescription = categories.length === 0
    ? null
    : isAdmin
      ? ".env 設定は .env、それ以外は override.env に保存します。"
      : "override.env にデフォルトからの変更点だけ保存します。";
  const changed = useMemo(() => categories.flatMap((category) => category.values).filter((setting) => draft[setting.key] !== undefined && !valuesEqual(setting, draft[setting.key], setting.value)), [categories, draft]);

  function updateSetting(key: string, value: string) {
    setDraft((current) => ({ ...current, [key]: value }));
    setNotice("未保存の変更があります");
  }

  function isAtDefault(setting: Setting) {
    const value = draft[setting.key] ?? setting.value;
    return valuesEqual(setting, value, setting.defaultValue);
  }

  function resetSettings(settings: Setting[]) {
    const resetKeys = new Set(settings.map((setting) => setting.key));
    const hasChangesAfterReset = changed.some((setting) => !resetKeys.has(setting.key))
      || settings.some((setting) => !valuesEqual(setting, setting.defaultValue, setting.value));
    setDraft((current) => {
      const next = { ...current };
      for (const setting of settings) next[setting.key] = setting.defaultValue;
      return next;
    });
    setNotice(hasChangesAfterReset ? "未保存の変更があります" : "設定は最新です");
  }

  function confirmReset() {
    if (!pendingReset) return;
    resetSettings(pendingReset.settings);
    setPendingReset(null);
  }

  async function save() {
    setBusy(true);
    const values = Object.fromEntries(changed.map((setting) => [setting.key, draft[setting.key] ?? setting.value]));
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
    const label = setting.label || setting.key;
    return <div key={setting.key} className={`setting-row ${isChanged ? "is-changed" : ""}`}>
      <span className="setting-label">
        <span className="setting-label-line">
          <strong>{label}</strong>
          <button type="button" className="setting-reset-button setting-reset-item" onClick={() => setPendingReset({ settings: [setting], label })} disabled={busy || isAtDefault(setting)} aria-label={`${label}を既定値に戻す`} title="既定値に戻す"><RotateCcw size={13} aria-hidden="true" /></button>
        </span>
        <small>{setting.description || (isChanged ? `既定値: ${setting.defaultValue}` : "既定値")}</small>
      </span>
      <div className={`setting-input setting-type-${setting.type.toLowerCase()}`}>{renderInput(setting, value)}</div>
    </div>;
  }

  function renderGroups(settings: Setting[]) {
    return groupSettings(settings).map((group, index) => {
      const key = sectionKey(activeCategory, group, index);
      const expanded = !group.collapsible || expandedSections[key] === true;
      const contentId = `settings-section-${key.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
      return <fieldset className={`settings-group ${group.collapsible ? "is-collapsible" : ""}`} key={key}>
        <legend>{group.collapsible ? <span className="settings-group-heading">
          <button type="button" className="settings-group-toggle" aria-expanded={expanded} aria-controls={contentId} onClick={() => setExpandedSections((current) => ({ ...current, [key]: !expanded }))}>{expanded ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}<span>{group.heading}</span><small>{expanded ? "表示中" : "非表示"}</small></button>
          <button type="button" className="setting-reset-button setting-reset-section" onClick={() => setPendingReset({ settings: group.settings, label: group.heading })} disabled={busy || group.settings.every(isAtDefault)} aria-label={`${group.heading}を既定値に戻す`} title={`${group.heading}を既定値に戻す`}><RotateCcw size={12} aria-hidden="true" /><span>戻す</span></button>
        </span> : group.heading}</legend>
        <div id={group.collapsible ? contentId : undefined} hidden={!expanded}>{group.settings.map(renderSetting)}</div>
      </fieldset>;
    });
  }

  return (
    <div className="app-shell">
      <aside className={`sidebar ${mobileNav ? "is-open" : ""}`}>
        <div className="sidebar-header">
          <div className="brand-mark"><TerminalSquare size={19} /> PALUI</div>
          <button className="icon-button mobile-close" onClick={() => setMobileNav(false)} aria-label="メニューを閉じる"><X size={18} /></button>
        </div>
        <div className="server-selector"><ServerStatusIndicator /><div><small>MANAGED SERVER</small><strong>palworld-server</strong></div></div>
        <nav className="main-nav" aria-label="メインナビゲーション">
          <p className="nav-label">OPERATIONS</p>
          {navItems.map(({ label, icon: Icon, href, active }) => <a href={`${basePath}${href}`} className={active ? "active" : ""} key={label}><Icon size={17} /> {label}{active && <span className="nav-pip" />}</a>)}
        </nav>
        <SidebarFooter />
      </aside>
      <main className="content-area">
        <header className="topbar">
          <button className="icon-button menu-trigger" onClick={() => setMobileNav(true)} aria-label="メニューを開く"><Menu size={20} /></button>
          <div className="breadcrumbs"><span>OPERATIONS</span><b>/</b><strong>設定</strong></div>
          <div className="topbar-meta"><span className="live-indicator"><i /> LIVE</span><span className="topbar-divider" /><span className="muted">17 Sep 2026, 14:32 JST</span></div>
        </header>
        <div className="page-content">
          <div className="page-heading">
            <div><p className="eyebrow">CONFIGURATION / 04</p><h1>設定</h1>{settingsDescription && <p className="muted">{settingsDescription}</p>}</div>
            <button className="primary-button" onClick={save} disabled={busy || changed.length === 0}><Save size={15} /> {busy ? "保存中..." : "変更を保存"}</button>
          </div>
          <div className={`notice-bar ${changed.length ? "notice-warning" : ""}`}><span className="notice-icon">{changed.length ? <FileCog size={14} /> : <Check size={14} />}</span><span>{notice}</span></div>
          <section className="settings-layout panel">
            <div className="settings-tabs" role="tablist">
              {categories.map((category) => {
                const hasChanges = category.values.some((setting) => draft[setting.key] !== undefined && !valuesEqual(setting, draft[setting.key], setting.value));
                return <button key={category.category} className={activeCategory === category.category ? "active" : ""} onClick={() => setActiveCategory(category.category)} role="tab">{labels[category.category] ?? category.category}{hasChanges && <span className="settings-tab-indicator" aria-label="未保存の変更あり" />}</button>;
              })}
            </div>
            <div className="settings-form">
              {active && <>
                <div className="settings-form-heading">
                  <h2>{labels[active.category] ?? active.category}</h2>
                  <button type="button" className="setting-reset-button setting-reset-category" onClick={() => setPendingReset({ settings: active.values, label: labels[active.category] ?? active.category })} disabled={busy || active.values.every(isAtDefault)} aria-label={`${labels[active.category] ?? active.category}の設定を既定値に戻す`} title={`${labels[active.category] ?? active.category}の設定を既定値に戻す`}><RotateCcw size={13} aria-hidden="true" /><span>カテゴリを既定値に戻す</span></button>
                </div>
                {renderGroups(active.values)}
              </>}
            </div>
          </section>
          <div className="settings-footer"><span><Check size={14} /> compose.yml は変更しません</span><span>{changed.length} 件の未保存変更</span></div>
        </div>
      </main>
      {pendingReset && <div className="dialog-backdrop" role="presentation" onClick={() => setPendingReset(null)}><section className="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="reset-confirm-title" onClick={(event) => event.stopPropagation()}><div className="dialog-icon"><RotateCcw size={20} aria-hidden="true" /></div><p className="eyebrow">RESET SETTINGS</p><h2 id="reset-confirm-title">設定を既定値に戻す</h2><p className="muted">対象: <strong>{pendingReset.label}</strong><br />選択した設定を既定値に戻します。変更は「変更を保存」を押すまで反映されません。</p><div className="dialog-actions"><button type="button" className="secondary-button" onClick={() => setPendingReset(null)}>キャンセル</button><button type="button" className="primary-button" onClick={confirmReset}>既定値に戻す</button></div></section></div>}
    </div>
  );
}
