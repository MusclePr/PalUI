#!/bin/bash

#
# PalServerSettings.env に残っている未定義のキーを列挙するスクリプト
#

set -euo pipefail

cd "$(dirname "$(readlink -f "$0")")"

declare -A KEYS

function load_keys() {
    local file key value
    for file in "$@"; do
        while IFS='=' read -r key value; do
            [[ "$key" =~ ^[[:space:]]*$ ]] && continue
            [[ "$key" =~ ^#.*$ ]] && continue
            KEYS["$key"]="$value"
        done < "$file"
    done
}

function remove_keys() {
    local file="$1"
    while IFS= read -r line; do
        key="${line%%=*}"
        [ -n "$key" ] && [ "${KEYS[$key]+_}" ] || echo $line
    done < "$file"
}

load_keys defaults/*.env
remove_keys PalServerSettings.env
