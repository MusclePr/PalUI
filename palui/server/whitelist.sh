#!/bin/bash

set -e

source .env

declare -a WHITELIST
declare -a NOT_WHITELIST
declare -a STEAM_IDS
declare -A STEAM_NAMES
declare PlayersJSON

MODE="${MODE:-console}"

PlayersJSONFile="./players.json"

function PlayersJSON_Load() {
  PlayersJSON="$(cat "${PlayersJSONFile}" 2> /dev/null || echo '[]')"
}

function PlayersJSON_Save() {
  echo "${PlayersJSON:-[]}" > "${PlayersJSONFile}"
}

function PlayersJSON_GetDisplayName() {
  echo "${PlayersJSON}" | jq -r --arg id "$1" '.[] | select(.id == $id) | .displayName'
}

function PlayersJSON_IsWhite() {
  echo "${PlayersJSON}" | jq -r --arg id "$1" '.[] | select(.id == $id) | .white'
}

function PlayersJSON_SetWhite() {
  PlayersJSON="$(echo "${PlayersJSON}" | jq --arg id "$1" --argjson white "${2:-true}" '
    if any(.[]; .id == $id)
    then map(if .id == $id then .white = $white else . end)
    else . end
  ')"
}

function PlayersJSON_Add() {
  local -r id="$1"
  local -r name="$2"
  local -r white="${3:-true}"
  PlayersJSON="$(echo "${PlayersJSON}" | jq --arg id "$id" --argjson white "$white" --arg name "$name" '
    if any(.[]; .id == $id)
    then map(if .id == $id then . + {"displayName": $name, "white": $white} else . end)
    else . + [{"id": $id, "displayName": $name, "white": $white}]
    end
  ')"
}

function PlayersJSON_SyncWhitelist() {
  local id name whitelist_json

  # 名前を解決できそうなものを steam_ids にかき集める
  local -a steam_ids=()
  for id in "${WHITELIST[@]}"; do
    name="$(PlayersJSON_GetDisplayName "$id")"
    if [ -z "${name}" ] && [[ "${id}" =~ ^steam_ ]]; then
      steam_ids+=("${id#steam_}")
    fi
  done
  # STEAM_NAMES 連想配列に、まとめて名前を取得する
  Fetch_GetSteamPlayerSummaries steam_ids

  for id in "${WHITELIST[@]}"; do
    name="${STEAM_NAMES["${id#steam_}"]}"
    if [ -z "${name}" ]; then
      name="$(PlayersJSON_GetDisplayName "$id")"
    fi
    PlayersJSON_Add "${id}" "${name}" "true"
  done
  # WHITELISTに無いidが見つかったら、white=falseにしておく
  whitelist_json="$(printf '%s\n' "${WHITELIST[@]}" | jq -R . | jq -s .)"
  PlayersJSON="$(echo "${PlayersJSON}" | jq --argjson wl "$whitelist_json" '
    map(
      .id as $id |
      if ($wl | index($id)) != null
      then .
      else .white = false
      end
    )
  ')"
}

function PlayerIds_ToSteamIds() {
  local -n player_ids=$1
  local -n steam_ids=$2
  local id steam_id
  for id in "${player_ids[@]}"; do
    steam_id="${id#steam_}"
    [ "${id}" != "${steam_id}" ] && ! IsContainOf steam_ids "${steam_id}" && steam_ids+=("${steam_id}") || true
  done
}

function Fetch_GetSteamPlayerSummaries() {
  local -n array=$1
  IFS=','
  local -r ids="${array[*]}"
  if [ -n "${ids}" ]; then
    local -r url="https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=${STEAM_WEBAPIKEY}&steamids=${ids}"
    local list id name
    #echo "URL: \"${url}\""
    list="$(curl -sSRL "${url}" | jq -r '.response.players[] | .steamid+","+.personaname')"
    while IFS=, read -r id name; do
      #printf 'STEAM_NAMES["%s"]="%s"\n' "${id}" "${name}"
      STEAM_NAMES["${id}"]="${name}"
    done <<< "${list}"
  fi
}

function FormatAnchor() {
  local -r url="${1}"
  local -r label="${2:-URL}"
  if [ "${MODE}" = "json" ]; then
    #printf '<a href="%s">%s</a>' "${url}" "${label}"
    printf '%s' "${label}"
  else
    printf '[\e]8;;%s\e\\%s\e]8;;\e\\]' "${url}" "${label}"
  fi
}

function LoadWhitelist() {
  local -n list=$1
  local ids id
  ids="$(jq -r '.[]' ./PalDefender/WhiteList.json)"
  while IFS= read -r id; do
    [ -z "${id}" ] && continue
    WHITEMAP[$id]=true
    list+=($id)
  done <<< "${ids}"
}

function GetSteamID() {
  local id="${1#steam_}"
  if [ "$1" != "$id" ]; then
    echo -n "${id}"
    return 0
  fi
  return 1
}

function FormatID() {
  local id="${1}"
  local steam_id name anchor white
  name="$(PlayersJSON_GetDisplayName "${id}")"
  white="$(PlayersJSON_IsWhite "${id}")"
  anchor="${name}"
  steam_id="$(GetSteamID "${id}")" && \
    anchor="$(FormatAnchor "https://steamcommunity.com/profiles/${steam_id}" "${name:-URL}")"
  if [ "${MODE}" = "json" ]; then
    if [[ "${anchor}" =~ href=\"([^\"]+)\"\>([^\<]+) ]]; then
      anchor="${BASH_REMATCH[1]}"
      name="${BASH_REMATCH[2]}"
      printf '{"id":"%s", "displayName":"%s", "white": %s, "url":"%s"}' "${id}" "${name}" "${white:-false}" "${anchor}"
    else
      printf '{"id":"%s", "displayName":"%s", "white": %s}' "${id}" "${anchor}" "${white:-false}"
    fi
  else
    printf '%s %s' "${id}" "${anchor}"
  fi
}

function ShowNumberedIDList() {
  local -n list=$1
  local -i i=0 last
  local id label comma
  last=$((${#list[@]}-1))
  if [ "${MODE}" = "json" ]; then echo '['; fi
  for id in "${list[@]}"; do
    if [ "${MODE}" = "json" ]; then
      label="$(FormatID "${id}")"
      comma="$([ $i -ne $last ] && echo ',' || echo '')"
      printf '  %s%s\n' "${label}" "${comma}"
    else
      label="$(FormatID "${id}")"
      printf '%2d: %s\n' "${i}" "${label}"
    fi
    i=$((i+1))
  done
  if [ "${MODE}" = "json" ]; then echo ']'; fi
}

function IsContainOf() {
  local -n list=$1
  for key in "${list[@]}"; do
    [ "${key}" = "${2}" ] && return 0
  done
  return 1
}

function FetchNotWhitelist() {
  local -n list=$1
  local ids id
  ids="$(docker logs ${NAME} | grep -E 'is not whitelisted' | sed -E 's/.+\] ([a-zA-Z0-9_]+) .*/\1/')"
  i=0
  while IFS= read -r id; do
    [ -z "${id}" ] && continue
    IsContainOf WHITELIST "${id}" && continue
    list+=("${id}")
  done <<< "${ids}"
}

WHITELIST=()
LoadWhitelist WHITELIST

PlayersJSON=""
PlayersJSON_Load
OldPlayerJSON="${PlayersJSON}"
PlayersJSON_SyncWhitelist
if [ "${OldPlayersJSON}" != "${PlayersJSON}" ]; then
  PlayersJSON_Save
fi

if [ "$1" = "list" ]; then
  echo "${PlayersJSON}"
  exit 0
elif [ "$1" = "remove" ]; then
  id="$2"
  if [ -z "${id}" ]; then
    echo "Usage: $(basename $0) remove <player_id>" >&2
    exit 1
  fi
  ./rcon.sh "whitelist_remove ${id}" 2>&1 >/dev/null && PlayersJSON_SetWhite "${id}" false && PlayersJSON_Save && exit 0
  exit 1
elif [ "$1" = "add" ]; then
  id="$2"
  name="$3"
  if [ -z "${id}" ] || [ -z "${name}" ]; then
    echo "Usage: $(basename $0) add <player_id> <name>" >&2
    exit 1
  fi
  ./rcon.sh "whitelist_add ${id}" 2>&1 >/dev/null && PlayersJSON_Add "${id}" "${name}" && PlayersJSON_Save && exit 0
  exit 1
fi

NOT_WHITELIST=()
FetchNotWhitelist NOT_WHITELIST

if [ "${#NOT_WHITELIST[@]}" -gt 0 ]; then
  STEAM_IDS=()
  PlayerIds_ToSteamIds NOT_WHITELIST STEAM_IDS
  Fetch_GetSteamPlayerSummaries STEAM_IDS
  ShowNumberedIDList NOT_WHITELIST
  [ "${MODE}" = "json" ] && exit 0
  read -p "番号：" -r n
  if [[ "${n}" =~ [0-9]+ ]]; then
    id="${NOT_WHITELIST[${n}]}"
    name="${STEAM_NAMES["${id#steam_}"]}"
    if [ -z "${name}" ]; then
      read -p "名前：" -r name
    fi
    if [ -n "${id}" ]; then
      echo "./rcon.sh \"whitelist_add ${id}\""
      ./rcon.sh "whitelist_add ${id}" 2>/dev/null && PlayersJSON_Add "${id}" "${name}" && PlayersJSON_Save && exit 0
      exit 1
    else
      echo "out of bounds" >&2
      exit 1
    fi
  else
    echo "quit" >&2
  fi
else
  echo "no entry" >&2
fi

exit 0
