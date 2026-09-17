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

process="$(docker ps -f 'name=palworld-server' --format 'json')"
status="$(echo "$process" | jq -r '.State')"
if [ "${status}" = "running" ]; then
  docker exec -itu steam palworld-server steam-login "$@"
else
  docker compose run --rm -it palworld steam-login "$@"
  network_name="$(docker compose config | sed -n '/networks:/,$ s/^[[:space:]]*name:[[:space:]]*//p')"
  [ -n "${network_name}" ] && docker network rm "${network_name}" || true
fi
