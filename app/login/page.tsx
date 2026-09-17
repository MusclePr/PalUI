"use client";

import { ArrowRight, KeyRound, ShieldCheck, TerminalSquare } from "lucide-react";
import { FormEvent, useEffect, useState } from "react";

export default function LoginPage() {
  const [busy, setBusy] = useState(false);
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [error, setError] = useState("");
  const basePath = process.env.NEXT_PUBLIC_BASE_PATH || "/palui";

  useEffect(() => {
    fetch(`${basePath}/api/auth/status`).then((response) => response.json()).then((data) => setConfigured(data.configured)).catch(() => setConfigured(false));
  }, []);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const form = new FormData(event.currentTarget);
    const payload = configured ? { account: String(form.get("account")), password: String(form.get("password")) } : { adminPassword: String(form.get("adminPassword")), adminPasswordConfirmation: String(form.get("adminPasswordConfirmation")), operatorPassword: String(form.get("operatorPassword")), operatorPasswordConfirmation: String(form.get("operatorPasswordConfirmation")) };
    const endpoint = configured ? "login" : "setup";
    const response = await fetch(`${basePath}/api/auth/${endpoint}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    const data = await response.json();
    if (response.ok) window.location.href = `${basePath}/dashboard`;
    else { setError(data.error ?? "認証に失敗しました"); setBusy(false); }
  }

  return (
    <main className="login-shell">
      <section className="login-aside">
        <div className="brand-mark"><TerminalSquare size={19} /> PALUI</div>
        <div className="login-intro">
          <p className="eyebrow">PALWORLD OPERATIONS CONSOLE</p>
          <h1>サーバー運用を、<em>静かに</em>把握する。</h1>
          <p className="muted lead">稼働状況、ログ、プレイヤー、設定をひとつの視界に集約します。</p>
        </div>
        <div className="login-aside-footer"><span className="signal-dot" /> control plane / local deployment</div>
      </section>
      <section className="login-panel">
        <div className="login-card">
          <div className="card-icon"><ShieldCheck size={20} /></div>
          <p className="eyebrow">SECURE ACCESS</p>
          <h2>{configured === false ? "初回パスワード設定" : "ログイン"}</h2>
          <p className="muted">{configured === false ? "管理者と運用者のパスワードを設定してください。" : "管理者または運用者の資格情報を入力してください。"}</p>
          {error && <p className="login-error" role="alert">{error}</p>}
          <form onSubmit={handleSubmit}>
            {configured === false ? <><label htmlFor="adminPassword">管理者パスワード</label><div className="input-with-icon"><KeyRound size={16} /><input id="adminPassword" name="adminPassword" type="password" autoComplete="new-password" minLength={8} required /></div><label htmlFor="adminPasswordConfirmation">管理者パスワード（確認）</label><div className="input-with-icon"><KeyRound size={16} /><input id="adminPasswordConfirmation" name="adminPasswordConfirmation" type="password" autoComplete="new-password" minLength={8} required /></div><label htmlFor="operatorPassword">運用者パスワード</label><div className="input-with-icon"><KeyRound size={16} /><input id="operatorPassword" name="operatorPassword" type="password" autoComplete="new-password" minLength={8} required /></div><label htmlFor="operatorPasswordConfirmation">運用者パスワード（確認）</label><div className="input-with-icon"><KeyRound size={16} /><input id="operatorPasswordConfirmation" name="operatorPasswordConfirmation" type="password" autoComplete="new-password" minLength={8} required /></div></> : <><label htmlFor="account">アカウント</label><select id="account" name="account" defaultValue="operator"><option value="operator">運用者</option><option value="admin">管理者</option></select><label htmlFor="password">パスワード</label><div className="input-with-icon"><KeyRound size={16} /><input id="password" name="password" type="password" placeholder="••••••••" autoComplete="current-password" required /></div></>}
            <button className="primary-button full-width" type="submit" disabled={busy}>
              {busy ? "処理中..." : configured === false ? "パスワードを設定" : "コンソールへ入る"} {!busy && <ArrowRight size={16} />}
            </button>
          </form>
          <p className="form-note">接続先: <strong>palworld-server</strong> / private network</p>
        </div>
      </section>
    </main>
  );
}