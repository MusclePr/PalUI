"use client";

import { ArrowRight, KeyRound, ShieldCheck, TerminalSquare } from "lucide-react";
import { FormEvent, useEffect, useState } from "react";

type LoginFormProps = {
  initialConfigured: boolean;
  initialAuthNotice?: string;
};

export function LoginForm({ initialConfigured, initialAuthNotice }: LoginFormProps) {
  const [busy, setBusy] = useState(false);
  const [configured, setConfigured] = useState(initialConfigured);
  const [account, setAccount] = useState("operator");
  const [error, setError] = useState(initialAuthNotice === "already-configured" ? "パスワードは設定済みです。ログインしてください。" : "");
  const basePath = process.env.NEXT_PUBLIC_BASE_PATH || "/palui";
  const needsSetup = !configured;

  useEffect(() => {
    fetch(`${basePath}/api/auth/status`).then((response) => response.json()).then((data) => setConfigured(Boolean(data.configured))).catch(() => undefined);
  }, [basePath]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const form = new FormData(event.currentTarget);
    if (needsSetup) {
      const state = await fetch(`${basePath}/api/auth/status`).then((response) => response.json()).catch(() => null) as { configured?: boolean } | null;
      if (state?.configured) {
        setConfigured(true);
        setError("パスワードは設定済みです。ログインしてください。");
        setBusy(false);
        return;
      }
    }
    const payload = needsSetup ? { adminPassword: String(form.get("adminPassword")), adminPasswordConfirmation: String(form.get("adminPasswordConfirmation")), operatorPassword: String(form.get("operatorPassword")), operatorPasswordConfirmation: String(form.get("operatorPasswordConfirmation")) } : { account: String(form.get("account")), password: String(form.get("password")) };
    const endpoint = needsSetup ? "setup" : "login";
    const response = await fetch(`${basePath}/api/auth/${endpoint}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    const data = await response.json() as { error?: string; code?: string };
    if (response.ok) {
      if (needsSetup) {
        setConfigured(true);
        setError("パスワードを設定しました。ログインしてください。");
        setBusy(false);
      } else window.location.href = `${basePath}/dashboard`;
    } else {
      if (data.code === "already-configured") setConfigured(true);
      setError(data.error ?? "認証に失敗しました");
      setBusy(false);
    }
  }

  return (
    <main className="login-shell">
      <section className="login-aside">
        <div className="brand-mark"><TerminalSquare size={19} /> PALUI</div>
        <div className="login-intro">
          <p className="eyebrow">PALWORLD SERVER CONSOLE</p>
          <h1>配信者のための <em>専用サーバー</em></h1>
          <p className="muted lead">稼働状況、ログ、プレイヤー、設定を解りやすく可視化します。</p>
        </div>
        <div className="login-aside-footer"><span className="signal-dot" /> control plane / local deployment</div>
      </section>
      <section className="login-panel">
        <div className="login-card">
          <div className="card-icon"><ShieldCheck size={20} /></div>
          <p className="eyebrow">SECURE ACCESS</p>
          <h2>{needsSetup ? "初回パスワード設定" : "ログイン"}</h2>
          <p className="muted">{needsSetup ? "管理者と運用者のパスワードを設定してください。" : "管理者または運用者の資格情報を入力してください。"}</p>
          {error && <p className="login-error" role="alert">{error}</p>}
          <form method="post" action={`${basePath}/api/auth/${needsSetup ? "setup" : "login"}`} onSubmit={handleSubmit}>
            {needsSetup ? <><label htmlFor="adminPassword">管理者パスワード</label><div className="input-with-icon"><KeyRound size={16} /><input id="adminPassword" name="adminPassword" type="password" autoComplete="new-password" minLength={8} required /></div><label htmlFor="adminPasswordConfirmation">管理者パスワード（確認）</label><div className="input-with-icon"><KeyRound size={16} /><input id="adminPasswordConfirmation" name="adminPasswordConfirmation" type="password" autoComplete="new-password" minLength={8} required /></div><label htmlFor="operatorPassword">運用者パスワード</label><div className="input-with-icon"><KeyRound size={16} /><input id="operatorPassword" name="operatorPassword" type="password" autoComplete="new-password" minLength={8} required /></div><label htmlFor="operatorPasswordConfirmation">運用者パスワード（確認）</label><div className="input-with-icon"><KeyRound size={16} /><input id="operatorPasswordConfirmation" name="operatorPasswordConfirmation" type="password" autoComplete="new-password" minLength={8} required /></div></> : <><label htmlFor="account">アカウント</label><select id="account" name="account" value={account} autoComplete="username" onChange={(event) => setAccount(event.currentTarget.value)}><option value="operator">運用者</option><option value="admin">管理者</option></select><input type="text" name="username" value={account} autoComplete="username" readOnly tabIndex={-1} aria-hidden="true" style={{ position: "absolute", width: 1, height: 1, opacity: 0, pointerEvents: "none" }} /><label htmlFor="password">パスワード</label><div className="input-with-icon"><KeyRound size={16} /><input id="password" name="password" type="password" placeholder="••••••••" autoComplete="current-password" required /></div></>}
            <button className="primary-button full-width" type="submit" disabled={busy}>
              {busy ? "処理中..." : needsSetup ? "パスワードを設定" : "コンソールへ入る"} {!busy && <ArrowRight size={16} />}
            </button>
          </form>
          <p className="form-note">接続先: <strong>palworld-server</strong> / private network</p>
        </div>
      </section>
    </main>
  );
}