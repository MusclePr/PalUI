import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "palui | Palworld Operations Console",
  description: "Palworld dedicated server operations console",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  // サーバー接続や認証の実装後も、アプリ全体の視覚的な土台はここで統一します。
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}