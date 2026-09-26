#!/bin/bash

# 
# Steam のログイン情報を保存するスクリプト
# 

set -euo pipefail

cd "$(dirname "$(readlink -f "$0")")"

[ -f .env ] && . .env

if [ -z "$STEAM_USERNAME" ]; then
  echo "STEAM_USERNAME is not set"
  exit 1
fi

process="$(docker compose ps --format json pal)"
status="$(echo "$process" | jq -r '.State')"
if [ "${status}" = "running" ]; then
  docker compose exec -itu steam pal steam-login "$@"
else
  docker compose run --rm -it pal steam-login "$@"
  network_name="$(docker compose config --format json | jq -r '.networks.default.name')"
  [ -n "${network_name}" ] && docker network rm "${network_name}" || true
fi
