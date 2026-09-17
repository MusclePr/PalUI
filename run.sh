#!/usr/bin/env bash

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

if [[ ! -f .nvmrc ]]; then
  echo "エラー: .nvmrc が見つかりません。" >&2
  exit 1
fi

if [[ -z "${NVM_DIR:-}" ]]; then
  export NVM_DIR="$HOME/.nvm"
fi

if [[ -s "$NVM_DIR/nvm.sh" ]]; then
  # 人間の確認環境でも、プロジェクトが要求する Node.js の版を必ず選択する。
  # これにより、シェルごとの Node.js 差分で UI の確認結果がぶれない。
  # shellcheck disable=SC1090
  source "$NVM_DIR/nvm.sh"
fi

if ! command -v nvm >/dev/null 2>&1; then
  echo "エラー: nvm が見つかりません。先に nvm をインストールしてください。" >&2
  exit 1
fi

nvm use --silent

if [[ ! -d node_modules ]]; then
  echo "依存関係をインストールしています..."
  npm ci
fi

HOST="${HOST:-localhost}"
PORT="${PORT:-3000}"
BASE_PATH="${NEXT_PUBLIC_BASE_PATH:-/palui}"
BASE_PATH="/${BASE_PATH#/}"
BASE_PATH="${BASE_PATH%/}"

echo
echo "palui のフロントエンドを起動します。"
echo "ログイン画面: http://${HOST}:${PORT}${BASE_PATH}/login"
echo "ダッシュボード: http://${HOST}:${PORT}${BASE_PATH}/dashboard"
echo "終了するには Ctrl+C を押してください。"
echo

exec npm run dev -- --hostname "$HOST" --port "$PORT"