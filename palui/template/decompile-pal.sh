#!/bin/bash

# 
# PalWorldSettings.ini から環境変数形式の設定ファイルを生成するスクリプト
# 

set -euo pipefail

cd "$(dirname "$(readlink -f "$0")")"

PALWORLDSETTINGS_INI="./palworld/Pal/Saved/Config/WindowsServer/PalWorldSettings.ini"
PALWORLDSETTINGS_TEMPLATE_URL="https://raw.githubusercontent.com/thijsvanloef/palworld-server-docker/refs/heads/main/scripts/files/PalWorldSettings.ini.template"
PALWORLDSETTINGS_ENV="./PalWorldSettings.env"
declare -A dict={}

# PalWorldSettings.ini のテンプレートを読み込み、dict 配列に格納します。
function LoadPalWorldSettingsTemplate() {
    local line key value
    while IFS= read -r line; do
        if [[ "$line" =~ ^([0-9A-Za-z_]+)=\$([0-9A-Za-z_]+),?$ ]]; then
            key="${BASH_REMATCH[1]}"
            value="${BASH_REMATCH[2]}"
            dict["$key"]="$value"
        fi
    done <<< "$(curl -sSLR "$PALWORLDSETTINGS_TEMPLATE_URL")"
}

# 指定された終端文字までの値を解析して返します。
function ScanTerminatedValue() {
    local value="$1"
    local term="${2:-\"}"
    local p=0
    local ptr
    while true; do
        ptr="${value:$p:4}"
        if [[ "$ptr" == "" ]]; then
            break
        fi
        if [[ "$ptr" =~ ^\\x[0-9A-Fa-f]{2} ]]; then
            ((p+=4))
            continue
        elif [[ "$ptr" =~ ^\\. ]]; then
            ((p+=2))
            continue
        fi
        if [[ "${ptr:0:1}" == "$term" ]]; then
            break
        fi
        ((p++))
    done
    echo "${value:0:$p}"
}

# この関数群は、PalWorldSettings.ini の OptionSettings を読みやすい形式に変換します。
# 具体的には、上記の例の様にカンマ区切りの設定を複数行に分割します。
function OptionSettings_preformatter() {
    local key value head="$1" scanned_value
    local -i p
    while [ -n "$head" ]; do
        if [[ "$head" =~ ^\s*([0-9A-Za-z_]+)=(.*)$ ]]; then
            key="${BASH_REMATCH[1]}"
            value="${BASH_REMATCH[2]}"
            # ここで value を解析して、カンマで分割可能か判断する処理を追加する予定です。
            if [[ "$value" =~ ^\( ]]; then
                # 配列の場合、1文字ずつ解析し、リテラルをスキップしつつ、終端のカッコまでを value とします。
                p=1
                scanned_value="$(ScanTerminatedValue "${value:$p}" ")")"
                p+=${#scanned_value}
                if [[ "${value:$p:1}" == ")" ]]; then
                    ((p++))
                fi
                value="${value:0:$p}"
            elif [[ "$value" =~ ^\" ]]; then
                # 文字列の場合
                p=1
                scanned_value="$(ScanTerminatedValue "${value:$p}" "\"")"
                p+=${#scanned_value}
                if [[ "${value:$p:1}" == "\"" ]]; then
                    ((p++))
                fi
                value="${value:0:$p}"
            else
                # その他の場合はカンマで分割可能か判断します。
                value="$(ScanTerminatedValue "$value" ",")"
            fi
        else
            # key=value の形式にマッチしない場合は、処理をスキップします。
            echo "Error: Invalid key=value format: $head" >&2
            exit 1
        fi
        if [ -n "${dict[$key]}" ]; then
            echo "${dict[$key]}=$value"
        else
            echo "# $key=$value"
        fi
        head="${head#"$key=$value"}"
        head="${head#,}"
    done
}

# 環境変数に変換した内容を表示します。
function ShowPalWorldSettingsEnv() {
    while IFS= read -r line; do
        if [[ "$line" =~ ^OptionSettings=\((.*)\)[[:space:]]*$ ]]; then
            echo "# OptionSettings"
            OptionSettings_preformatter "${BASH_REMATCH[1]}"
            return 0
        fi
    done < "$PALWORLDSETTINGS_INI"
    echo "Error: OptionSettings=(...) not found in $PALWORLDSETTINGS_INI" >&2
    return 1
}

if [ ! -f "$PALWORLDSETTINGS_INI" ]; then
    echo "Error: $PALWORLDSETTINGS_INI not found."
    exit 1
fi

LoadPalWorldSettingsTemplate
ShowPalWorldSettingsEnv > "$PALWORLDSETTINGS_ENV"
cat "$PALWORLDSETTINGS_ENV"
