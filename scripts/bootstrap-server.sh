#!/usr/bin/env bash

set -Eeuo pipefail

trap 'echo "Server initialization failed: command failed at line $LINENO" >&2' ERR

fail() {
  echo "Server initialization failed: $*" >&2
  exit 1
}

# 引数の解析
template=''
destination=''
host_server_dir=''
while (($#)); do
  case "$1" in
    --template|--destination|--host-server-dir)
      option="$1"
      [[ $# -ge 2 && -n "$2" && "$2" != --* ]] || fail "Missing value for $option"
      case "$option" in
        --template) template="$2" ;;
        --destination) destination="$2" ;;
        --host-server-dir) host_server_dir="$2" ;;
      esac
      shift 2
      ;;
    *) fail "Unknown argument: $1" ;;
  esac
done
[[ -n "$template" && -n "$destination" ]] || \
  fail 'Usage: bootstrap-server.sh --template DIR --destination DIR [--host-server-dir DIR]'

# 必要なコマンドの確認
command -v jq >/dev/null 2>&1 || fail 'jq is required'
[[ -d "$template" ]] || fail "Template directory does not exist: $template"
mkdir -p -- "$destination"

# 現在のユーザーIDとグループIDの取得
uid="${PUID-$(id -u)}"
gid="${PGID-$(id -g)}"
[[ "$uid" =~ ^[0-9]+$ ]] || fail 'PUID must be a non-negative integer'
[[ "$gid" =~ ^[0-9]+$ ]] || fail 'PGID must be a non-negative integer'
current_uid="$(id -u)"

# 所有権を設定する関数
set_owner() {
  if [[ "$current_uid" == 0 ]]; then
    chown -- "$uid:$gid" "$1"
  fi
}

# テンプレートの環境変数ファイルをコピー
if [[ ! -d "$destination/defaults" ]]; then
  mkdir -p -- "$destination/defaults"
  set_owner "$destination/defaults"
fi
shopt -s nullglob
default_env_files=("$template"/defaults/*.env)
env_files=("$template"/*.env)
if ((${#default_env_files[@]})); then
  cp -auv -- "${default_env_files[@]}" "$destination/defaults/"
fi
if ((${#env_files[@]})); then
  cp -auv -- "${env_files[@]}" "$destination/"
fi

# ホスト側の /server ディレクトリのパスを取得
if [[ -n "$host_server_dir" ]]; then
  host_server_dir="$(realpath -e -- "$host_server_dir" || exit; printf '.')"
  host_server_dir="${host_server_dir%.}"
  # realpath prints a newline; retain any newlines belonging to the path.
  host_server_dir="${host_server_dir%$'\n'}"
else
  mount_root=''
  while IFS=' ' read -r _ _ _ root mountpoint _; do
    if [[ "$mountpoint" == /server ]]; then
      mount_root="$root"
      break
    fi
  done < /proc/self/mountinfo
  [[ -n "$mount_root" ]] || fail 'Could not find the /server bind mount in /proc/self/mountinfo'
  printf -v host_server_dir '%b' "$mount_root"
  [[ "$host_server_dir" == /* ]] || fail "The /server mount source is not an absolute path: $host_server_dir"
fi

project_name="${COMPOSE_PROJECT_NAME:-${PROJECT:-dev}_pal}"
[[ "$project_name" =~ ^[a-z0-9][a-z0-9_-]*$ ]] || fail "Invalid Compose project name: $project_name"
compose_source="${host_server_dir//\$/\$\$}/palworld"

# Compose テンプレートを置換して出力
compose_template="$template/template.compose.yml"
grep -qF '__HOST_SERVER_DIR__' "$compose_template" || fail 'Compose template does not contain __HOST_SERVER_DIR__'
grep -qF '__PROJECT_PAL__' "$compose_template" || fail 'Compose template does not contain __PROJECT_PAL__'
escaped_source="$(jq -nr --arg source "$compose_source" '$source | tojson')"
escaped_source="${escaped_source//\\/\\\\}"
escaped_source="${escaped_source//&/\\&}"
escaped_source="${escaped_source//|/\\|}"
{
  printf '%s\n' '# Generated from template.compose.yml at startup; local edits are overwritten.'
  sed -e "s|__HOST_SERVER_DIR__|$escaped_source|g" \
      -e "s|__PROJECT_PAL__|\"$project_name\"|g" "$compose_template"
} > "$destination/compose.yml"
chmod 644 -- "$destination/compose.yml"
set_owner "$destination/compose.yml"
