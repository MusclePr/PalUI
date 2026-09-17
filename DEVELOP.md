<!-- markdownlint-disable MD013 -->

# palui 開発要求仕様書

## 1. 文書の目的

本書は、Palworld Dedicated Server Docker をブラウザから運用する Web UI、`palui` の開発要求を定義しています。
この文書は、具体的な設計を通じて、最終的に開発設計仕様書に変わります。

`palui` は、[thijsvanloef/palworld-server-docker](https://github.com/thijsvanloef/palworld-server-docker) の Docker Compose プロジェクトを単一サーバーとして制御・可視化します。
設計、画面レイアウトは [MusclePr/asaui](https://github.com/MusclePr/asaui) を参考にします。
ただし、ARK 固有の機能や複数サーバーの概念は継承しません。この文書では、Palworld 固有の用語と情報を使用します。

本書でいう「初期版」は、ゲームイメージの更新実行を含まない。対象イメージの公開仕様変更に追随できるよう、対応する環境変数および REST API の定義はアプリケーション内で更新可能にする。

## 2. プロジェクト概要

### 2.1 目的

- 単一の Palworld 専用サーバーの稼働状況、リアルタイムログ、CPU・メモリ等のリソース、オンラインプレイヤーを一画面で把握できること。
- サーバーの起動、停止、再起動、保存、ゲーム内アナウンス、プレイヤー管理、バックアップを安全に実行できること。
- ホスト上の `/server/compose.yml` が参照する設定ファイルを、入力検証と差分確認付きで編集できること。
- REST API ポートを外部公開せず、Docker Socket を経由してゲーム内管理操作を実行できること。

### 2.2 対象読者

- Palworld 専用サーバーの所有者および日常運用者
- palui の実装者、テスト担当者、レビュー担当者

### 2.3 用語

| 用語 | 定義 |
| --- | --- |
| palui | 本仕様で開発する Web UI とその API を提供する Compose サービス。 |
| 対象プロジェクト | ホストの `/server/compose.yml` を対象とする Palworld 用 Docker Compose プロジェクト。 |
| 対象コンテナ | 対象プロジェクトに属する `thijsvanloef/palworld-server-docker` のコンテナ。通常は `palworld` サービス。 |
| 管理者 | 全機能を実行できる認証済み利用者。 |
| 運用者 | 管理者資格情報の変更・確認を除く機能を実行できる認証済み利用者。 |
| REST API操作 | 対象コンテナ内の `rest-cli` を実行し、Palworld REST API を呼び出す操作。 |

## 3. スコープ

### 3.1 初期版に含めるもの

- 単一対象プロジェクトの Compose ライフサイクル制御
- 対象コンテナの状態、ログ、リソース使用量、ゲーム情報の可視化
- thijsvanloef/palworld-server-docker が提供する REST API、環境変数、`rest-cli` に対応した操作
- REST API によるサーバー操作およびプレイヤーの表示・キック・BAN・BAN 解除
- `/server/compose.yml` が参照する dotenv ファイルの編集
- バックアップの一覧、作成、復元
- 管理者・運用者の2ロールによるロールベース認可
- `PalWorldSettings.ini` に対応する環境変数に対するGUI編集機能（`PalWorldSettings.ini`と`PalServerSettings.env`の相互変換）
  - `/server/decompile-pal.sh` にて `PalWorldSettings.ini` から設定環境変数へ変換する。
  - 設定環境変数を `defaults/game_*.env` に分類する。
    - 分け方は、[設定パラメータ](https://docs.palworldgame.com/ja/settings-and-operation/configuration) を参考にしました。
    - GUI でもこの分類に基づいてタブページ分けを行いたいが、既に使用されていないパラメータなども含まれている可能性もあり、分類については後から変更しやすい形が望ましい。
    - デフォルト値は便宜上分類するが、`docker compose config` では `environment` としてフラットに展開されるため、変更値は `override.env` に集約する。

### 3.2 初期版には不要と考えているもの

- 複数サーバー、`asa0` のような複数サービス群、クラスターの概念
- EOS ID とセーブデータまたはマップの紐付け
- 複数サーバー間で共有するプレイヤーのバイパスリスト
- ARK 向け MOD 管理、CurseForge 連携は、そのまま動かない。ASA 向けには、Steam Workshop 連携が必要。
- `PalWorldSettings.ini` の直接編集は不要。

## 4. 配置構成と責務

### 4.1 必須のホスト構成

管理対象プロジェクトの `compose.yml` はホストの `./palui/server/` に配置する。
palui の Compose プロジェクトからは、同じディレクトリを `/server` としてバインドマウントする。

```text
host
`- palui/
  |- .env
  |- compose.yml ... palui 自体の compose
  `- server/
    |- defaults/ ... 読み取り専用のディレクトリとファイル群
    |  |- game_balance.env
    |  |- game_features.env
    |  |- game_performance.env
    |  |- game_server.env
    |  `- system.env
    |- palworld/ ... Palworld 専用サーバーのデータディレクトリ
    |- .env ... ホスト向け環境変数（palui の管理対象）
    |- compose.yml ... Palworld 専用サーバーのComposeファイル（palui の管理対象）
    `- override.env ... コンテナ向け環境変数（palui の管理対象）
```

```mermaid
flowchart LR
  Browser[管理者・運用者のブラウザ] --> Proxy[リバースプロキシ]
  Proxy --> UI[palui: Next.js]
  UI --> Socket[/var/run/docker.sock]
  UI --> ServerDir[/server: bind mount]
  Socket --> Docker[Docker daemon]
  Docker --> Palworld[palworld-server container]
  ServerDir --> Compose[compose.yml and dotenv files]
```

palui サービスは少なくとも次をマウントする。

```yaml
services:
  palui:
    volumes:
      - ./server:/server
      - /var/run/docker.sock:/var/run/docker.sock
```

### 4.2 制御経路

| 操作種別 | 実行経路 | 用途 |
| --- | --- | --- |
| プロジェクト操作 | `docker compose --project-directory /server <up|down|ps|config|...>` | `up`、`down`、`ps`、`config` など Compose が責務を持つ操作。 |
| コンテナ操作 | Docker Socket API を Dockerode 等で呼び出す | 状態照会、開始、停止、再起動、ログ、統計、コンテナ内コマンド実行。 |
| ゲーム内操作 | Docker Socket API の exec で `rest-cli` を実行 | REST APIによる情報取得、告知、保存、プレイヤー管理、終了。 |
| 設定操作 | `/server` のファイル API | 対象Composeとdotenvの読取、検証、原子的保存。 |

Compose コマンドを組み立てる際、利用者入力をシェル文字列として連結してはならない。固定したサブコマンドと引数配列を使い、許可した操作だけを実行する。

## 5. 機能要件

### 5.1 ダッシュボード

ダッシュボードはログイン後の既定画面とし、以下を提供する。

- 対象プロジェクトと対象コンテナの状態を `未作成`、`停止中`、`起動中`、`起動準備中`、`停止処理中`、`異常` として明示する。
- コンテナ名、イメージタグ、稼働時間、再起動回数、Compose サービス名を表示する。
- `info`、`players`、`metrics` を定期取得し、サーバーバージョン、オンライン人数、CPU、メモリを表示する。
- Docker の stats 取得に失敗した場合、最後に取得できた値と取得時刻を示し、推測値を表示しない。
- 対象コンテナの標準出力を SSE でストリーミング表示する。ANSI エスケープシーケンスを安全に表示し、ログの最大保持量を設ける。
- 状態、メトリクス、ログストリームのいずれかが失敗しても、他の表示と操作は継続可能とする。

### 5.2 サーバーライフサイクル

| 操作 | 実行内容 | 権限 | 確認 |
| --- | --- | --- | --- |
| 起動 | `docker compose --project-directory=/server up -d` を実行する。 | 管理者、運用者 | 不要 |
| 正常停止 | `rest-cli shutdown` で告知付き終了を要求し、完了状態を監視する。 | 管理者、運用者 | 必須 |
| 強制停止 | `rest-cli stop` またはDocker停止を実行する。 | 管理者、運用者 | 強い確認 |
| 再起動 | 保存後に正常停止し、Composeで再起動する。 | 管理者、運用者 | 必須 |
| 保存 | `rest-cli save` を実行し結果を表示する。 | 管理者、運用者 | 不要 |

停止・再起動では、待機秒数と告知メッセージを入力可能にする。入力値は API が期待する JSON として構築し、任意のコマンド断片を受け付けない。実行中のライフサイクル操作は対象プロジェクト単位で排他する。

### 5.3 REST API によるゲーム操作

palui は以下の REST API 操作を提供する。返却 JSON は構造化して表示し、資格情報、トークン、環境変数の秘密値をレスポンスへ残してはならない。

| REST API | UI 機能 | 権限 |
| --- | --- | --- |
| `info` | サーバー情報表示 | 管理者、運用者 |
| `players` | オンラインプレイヤー一覧 | 管理者、運用者 |
| `settings` | 実行中設定の読取専用表示 | 管理者、運用者 |
| `metrics` | メトリクス表示 | 管理者、運用者 |
| `announce` | 全体告知 | 管理者、運用者 |
| `save` | ワールド保存 | 管理者、運用者 |
| `kick` | プレイヤーをキック | 管理者、運用者 |
| `ban` | プレイヤーを BAN | 管理者、運用者 |
| `unban` | プレイヤーの BAN を解除 | 管理者、運用者 |
| `shutdown` | 告知付き正常終了 | 管理者、運用者 |
| `stop` | 強制終了 | 管理者、運用者 |

対象イメージが提供する `rest-cli` のバージョン差分に備え、API呼出層はUIから分離する。未対応のコマンドはボタンを無効化し、検出した理由を表示する。

導入済みのMODが提供するRCON機能により、ホワイトリストを管理できる。MODが未導入またはコマンドが未対応の場合は、機能を無効化し理由を表示する。

`docker exec -itu steam palworld-server rcon-cli <RCONコマンド>`

| RCONコマンド | UI機能 | 権限 |
| --- | --- | --- |
| `whitelist_list` | ホワイトリストメンバーの一覧 | 管理者、運用者 |
| `whitelist_add <player ID>` | ホワイトリストメンバーの追加 | 管理者、運用者 |
| `whitelist_remove <player ID>` | ホワイトリストメンバーの削除 | 管理者、運用者 |

プレイヤーIDだけでは利用者を識別しにくいため、`players` の応答を表示名との対応付けに利用する。対応する表示名が取得できない場合は、プレイヤーIDをそのまま表示する。

### 5.4 プレイヤー管理

- `players` の応答を、プレイヤー ID、表示名、接続状態、接続時刻など API が返す値に限定して一覧表示する。
- プレイヤー ID はクリップボードにコピー可能にする。
- キック、BAN、BAN 解除は対象プレイヤーと理由を確認するダイアログを経由する。
- 操作成功時は API 応答を表示し、一覧を再取得する。失敗時は操作対象、時刻、失敗理由を表示する。
- ホワイトリストは、RCONコマンドまたは `/server/palworld/Pal/Binaries/Win64/PalDefender/WhiteList.json` から取得する。ファイルは読み取り専用の状態表示に利用し、変更はRCON経由で行う。

### 5.5 ログと診断

- Docker API のログストリームを SSE で配信する。接続断時は指数バックオフで再接続し、利用者が明示停止できる。
- ログはテキストとしてエスケープして表示し、HTML として挿入してはならない。
- 時刻範囲、キーワード、ログレベルによるクライアント側フィルタを提供する。
- 直近のCompose操作、REST API操作、バックアップ操作の結果を診断パネルに表示する。

### 5.6 バックアップ

バックアップデータの保存先は対象イメージの `/palworld/backups/` を前提とする。palui は Docker API を経由して対象コンテナの `backup` コマンドを実行する。

- バックアップ一覧にはファイル名、作成日時、サイズ、整合性確認結果を表示する。
- 作成前に `rest-cli save` を実行し、保存失敗時は実行者の明示承認なしにバックアップを続行しない。
- 復元は管理者・運用者が実行できる。対象バックアップの選択、サーバー停止、バックアップ名の再入力、復元内容と影響の表示を必須にする。
- 復元処理は対象コンテナが停止済みであることを確認し、対象イメージが提供する復元手順または検証済みの非対話スクリプトだけを使用する。
- 復元後は必要な `DedicatedServerName` などの設定整合性を検証し、実行者の選択に応じてComposeを起動する。
- 復元の途中失敗時は、自動起動せず、実行済み段階と手動復旧手順を表示する。

## 6. 設定編集要件

### 6.1 編集対象と保存手順

paluiは `/server/compose.yml` を直接編集しない。対象Composeが `env_file` で参照する `/server` 配下のdotenvファイル、具体的には `/server/.env`、`/server/override.env`、`/server/defaults/*.env` を編集対象とする。`defaults/*.env` は既定値として扱い、通常の変更値は `override.env` に保存する。
対象Composeは事前に用意されているものを使用し、存在しない場合は設定操作をエラーとして終了する。

保存手順は次の順に固定する。

1. 現在のファイルを読み込み、更新時刻と内容ハッシュを保持する。
2. dotenvを構文解析し、スキーマ・型・値域・依存関係を検証する。対象Composeは読み取り専用に解析する。
3. `docker compose --project-directory=/server config` で Compose の展開可否を検証する。
4. 変更前後の差分と、再作成・再起動が必要な項目を表示し、実行者の保存確認を受ける。
5. 一時ファイルへ書き込み、fsync 後に同一ファイルシステム内で原子的に置換する。
6. 保存直前にハッシュを再確認し、外部変更を検知した場合は保存せず競合を通知する。

dotenvは専用パーサーを使う。文字列置換だけでdotenvを更新してはならない。コメントや未管理キーを可能な限り保存し、保存できない構文は破壊せず読み取り専用として扱う。対象Composeの解析にも専用のYAMLパーサーを使う。

### 6.2 設定画面

設定画面の設定項目は、`server/defaults/*.env` の分類を基準にする。

- システム（system.env）
- サーバー（defaults/game_server.env）
- ゲーム機能（defaults/game_features.env）
- ゲームバランス（defaults/game_balance.env）
- パフォーマンス（defaults/game_performance.env）

パスワードなどの秘密値は画面、差分、エラー画面で既定マスクする。

### 6.3 設定反映

Compose環境変数の変更は、原則として対象コンテナの再作成または再起動まで反映されない。
保存後に palui は「保存済み・未反映」と表示し、再作成ボタンを選択したら `docker compose --project-directory=/server up -d` を実行する。

対象イメージが起動時に生成する設定ファイルを直接編集する操作は初期版では提供しない。

## 7. 認証・認可・監査

### 7.1 認証

- palui はログイン必須とし、管理者用と運用者用の別資格情報を環境変数またはシークレットで受け取る。
- 平文パスワードは保存しない。パスワードハッシュを使用し、比較にはタイミング攻撃に耐性のある手法を使う。
- セッション Cookie は `HttpOnly`、`Secure`、`SameSite` を設定する。TLS 終端がリバースプロキシの場合も、転送ヘッダーを信頼する送信元を固定する。
- Cookie を使う変更 API は CSRF 対策を必須とする。

### 7.2 認可マトリクス

| 機能 | 管理者 | 運用者 |
| --- | --- | --- |
| ダッシュボード、ログ、メトリクス、実行中設定 | 可 | 可 |
| プレイヤー一覧、告知、保存 | 可 | 可 |
| 起動、停止、再起動、再作成 | 可 | 可 |
| キック、BAN、BAN 解除 | 可 | 可 |
| RCONによるホワイトリスト管理 | 可 | 可 |
| Compose・dotenvの閲覧と変更 | 可 | 可 |
| バックアップ作成、復元 | 可 | 可 |
| 管理者資格情報の変更・確認 | 可 | 不可 |

認可は画面の非表示だけで実現してはならない。すべての Route Handler、Server Action、SSE 接続でサーバー側の認可を実施する。

## 8. UI/UX 要件

asaui のように、サイドバーによる明確な画面遷移、状態を優先した情報密度、非同期操作の即時フィードバックを採用する。画面は操作説明を常時表示せず、ラベル、ツールチップ、空状態、確認ダイアログで文脈を伝える。

### 8.1 画面一覧

| 画面 | パス | 内容 |
| --- | --- | --- |
| ログイン | `/login` | 管理者・運用者の認証。 |
| ダッシュボード | `/` | サーバー状態、メトリクス、オンライン人数、操作、リアルタイムログ。 |
| プレイヤー | `/players` | オンラインプレイヤー一覧、告知、キック/BAN、ホワイトリスト管理。 |
| バックアップ | `/backups` | 一覧、作成、復元。 |
| 設定 | `/settings` | dotenvのフォーム編集、差分、反映状態。 |

### 8.2 表現と操作

- アイコンは Lucide React を使用し、アイコンのみの操作にはツールチップとアクセシブルな名前を付与する。
- 状態色だけに依存せず、テキスト、アイコン、スクリーンリーダー向けラベルを併用する。
- 破壊的操作は危険色、対象、影響、確認操作を一貫して表示する。復元と強制停止は対象名の再入力を必須とする。
- 操作中は対象ボタンを無効化し、進行状況、タイムアウト、取消可能性を示す。
- デスクトップでは監視と操作を同時に行える密度を確保し、モバイルではログ、表、設定フォームを縦方向に再配置する。
- キーボード操作、フォーカス可視化、十分なコントラスト、エラーの関連付けを満たす。

## 9. 推奨技術構成

| 領域 | 推奨技術 | 方針 |
| --- | --- | --- |
| アプリケーション | Next.js App Router | Server Component を既定とし、ブラウザ状態が必要な部分だけを Client Component にする。 |
| 言語 | TypeScript | Docker、Compose、REST API、設定の入出力を型で表現する。 |
| UI | Tailwind CSS、Lucide React | 既存の asaui に近い実務的で情報密度の高い管理 UI を構築する。 |
| Docker API | Dockerode または同等の Docker Engine API クライアント | Socket 接続をサーバー側に限定する。 |
| ログ配信 | Server-Sent Events | Docker ログをサーバー経由でブラウザへ配信する。 |
| 設定解析 | YAML/dotenv パーサー | 文字列操作で YAML・dotenv を編集しない。 |
| スキーマ検証 | Zod 等 | API 入力、設定値、REST API 応答を検証する。 |

ブラウザへ Docker Socket、対象コンテナ ID、Compose コマンド実行権限、秘密値を渡してはならない。すべての Docker 操作は認可済みサーバー API の内部で実行する。

## 10. 非機能要件

### 10.1 可用性と失敗時の挙動

- Docker Socket、`/server`、対象コンテナ、REST API の接続失敗を個別に検出・表示する。
- API 呼出には操作種別ごとのタイムアウトを設定し、タイムアウト後も実際の状態を再照会する。
- 同じ対象へ同時に行う停止、再起動、復元、設定反映はサーバー側ロックで直列化する。

### 10.2 セキュリティ

- Docker Socket はホストの実質的な管理者権限である。palui は認証済み利用者だけが到達できるネットワークに配置し、Docker Socket を他サービスへ共有しない。
- コンテナの実行ユーザーには Socket 接続に必要な最小権限だけを付与する。
- `/server` 以外のファイルへ到達できるパス指定、シンボリックリンク経由の書込み、任意コマンド実行を禁止する。
- ログ、エラー、設定プレビュー、バックアップ名は出力時にエスケープする。
- REST API ポート `8212/tcp` をインターネットへ公開してはならない。
- リバースプロキシ配下のサブパス運用を想定し、アセット、認証コールバック、SSE の URL をベースパスから正しく解決する。

### 10.3 性能と保持

- ダッシュボードの定期取得は負荷に応じて間隔を調整し、非表示タブでは頻度を下げる。
- ログのブラウザ内保持量とサーバー中継バッファに上限を設け、長時間接続でメモリを無制限に使わない。
- バックアップ一覧はページネーションが不要な程度に収まる。

## 11. テスト・受入基準

### 11.1 テスト方針

- Composeコマンド生成、設定パース、設定検証、権限判定、REST APIのJSON組立をユニットテストする。
- Docker Engine API と `rest-cli` をスタブした統合テストで、成功、タイムアウト、対象不在、権限不足、実行中ロックを検証する。
- ブラウザ E2E テストで、ログイン、ロール別表示、設定保存と競合、告知、保存、バックアップ作成、復元確認画面を検証する。
- 実 Docker 環境で、`docker compose --project-directory=/server config`、コンテナのログ配信、`rest-cli info`、バックアップ作成のスモークテストを実施する。

### 11.2 受入基準

- 管理者はブラウザから対象プロジェクトの状態を確認し、起動、保存、告知、停止、再起動を実行できる。
- 運用者は管理者資格情報の変更・確認を除き、ダッシュボード、ログ、プレイヤー、メトリクス、告知、保存、ライフサイクル、プレイヤー管理、バックアップ、設定変更を実行できる。
- 設定変更はdotenvとCompose展開の検証を通過したときだけ保存され、外部変更との競合時には上書きされない。対象Compose自体は変更しない。
- REST API ポートをホスト公開しない構成で、palui から `info`、`players`、`announce`、`save` を実行できる。
- バックアップ復元は管理者・運用者が実行でき、対象名再入力、停止確認が必ず行われる。
- RCONによるホワイトリスト管理は、対応MODが導入されている場合に一覧、追加、削除を実行できる。未導入時は理由を表示して無効化する。
- 複数サーバー、EOS ID連携、複数サーバー間のバイパスリスト、ARK MOD管理はUIとAPIに存在しない。

## 12. 将来の検討項目

- CPU、メモリ、ディスク容量、バックアップ失敗、停止状態の健全性アラート
- バックアップ保持ポリシー、暗号化、S3 等の外部ストレージへの退避と復旧演習
- 読み取り専用の診断情報エクスポート
- 設定テンプレート、インポート、エクスポート、変更履歴からのロールバック
- Discord Webhook の設定状態と配送結果の可視化
- 予約メンテナンス、事前告知、停止までのカウントダウン
- OIDC など外部認証基盤との連携

## 13. 参照資料

- [thijsvanloef/palworld-server-docker README](https://github.com/thijsvanloef/palworld-server-docker)
- [palworld-server-docker compose.yaml](https://github.com/thijsvanloef/palworld-server-docker/blob/main/compose.yaml)
- [palworld-server-docker .env.example](https://github.com/thijsvanloef/palworld-server-docker/blob/main/.env.example)
- [MusclePr/asaui DESIGN.md](https://github.com/MusclePr/asaui/blob/main/DESIGN.md)
- [MusclePr/asaui DEVELOP.md](https://github.com/MusclePr/asaui/blob/main/DEVELOP.md)
