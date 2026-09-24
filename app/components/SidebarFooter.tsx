"use client";

import { LogOut } from "lucide-react";
import { useEffect, useState } from "react";

type AuthRole = "admin" | "operator";

const basePath = process.env.NEXT_PUBLIC_BASE_PATH || "/palui";

const roleMeta: Record<AuthRole, { account: string; label: string; initials: string }> = {
  admin: { account: "admin", label: "管理者", initials: "AD" },
  operator: { account: "operator", label: "運用者", initials: "OP" },
};

export function SidebarFooter() {
  const [role, setRole] = useState<AuthRole | null>(null);
  const meta = role ? roleMeta[role] : { account: "--", label: "未確認", initials: "--" };

  useEffect(() => {
    fetch(`${basePath}/api/auth/status`)
      .then((response) => response.json())
      .then((data) => setRole(data.role === "admin" || data.role === "operator" ? data.role : null))
      .catch(() => setRole(null));
  }, []);

  async function logout() {
    await fetch(`${basePath}/api/auth/logout`, { method: "POST" });
    window.location.href = `${basePath}/login`;
  }

  return <div className="sidebar-footer"><div className="operator-avatar">{meta.initials}</div><div><strong>{meta.account}</strong><small>{meta.label}</small></div><button className="icon-button" aria-label="ログアウト" onClick={logout}><LogOut size={16} /></button></div>;
}