# GeoCode-Web-SingleBin 仕様書

## 1. 概要

本プロジェクトは、Rust/Axum 製の API サーバーと Vue 3 製のフロントエンドを 1 つの配布物にまとめたマッピングアプリケーションである。通常は Tauri アプリとして動作し、初回セットアップ後にローカル HTTP サーバーを内蔵起動して UI を表示する。加えて `-s` オプションによるサーバー単体モードも備える。

主な目的は以下のとおり。

- オフラインまたはローカルネットワーク内で動作する個人向け/小規模チーム向け地図メモ環境を提供する
- 地図上のマーカーに Markdown ベースの説明を紐付け、簡易 Wiki として扱えるようにする
- レイヤに紐付いたポリゴン/ポリライン/矩形を描画し、地図上の範囲や経路を表現できるようにする
- 画像・PDF・動画をアップロードし、マーカー詳細へ埋め込めるようにする
- レイヤ単位で情報を整理し、JSON によるエクスポート/インポートで持ち運び可能にする
- 必要な範囲だけを一時共有 URL として外部共有し、必要に応じて共有パスワードで保護できるようにする
- Windows 向けにセットアップ済みの単一配布物として提供し、導入を簡素化する

### GeoCode-Web との差異吸収

PostgreSQL から SQLite を使用することによる差分吸収は **全てバックエンドで行う**。これにより **フロントエンドは全て同一のものをコピーして使用可能な状態とする**。つまり、 SingleBin のフロントエンドにて発生したエラーはバックエンドで修正する。これは `src/templates` も同様。

**具体例**

- PostgreSQL の JSONB が使えないため、本体は `serde_json::Value` を使用するところ、 String 型となる場合は、テキストから JSON へのパースはフロントではなく、バックエンドで行ってから返却するといったもの。

## 2. システム構成

### 2.1 バックエンド

- 言語: Rust 2024
- Web: Axum
- DB: SQLite
- テンプレート: Tera
- 認証: JWT(access/refresh) + HttpOnly Cookie
- 二段階認証: TOTP
- 静的ファイル配布: `rust-embed`

### 2.2 フロントエンド

- Vue 3 + Vue Router + Pinia
- Vite ビルド
- `marked` によるプレビュー強化
- `ace-builds` (Ace Editor) によるコード編集
- Service Worker 登録あり

### 2.3 デスクトップラッパー

- Tauri 2
- 通常起動時は `http://localhost:3000/index` を WebView で開く
- 外部リンクは Tauri コマンド経由で既定ブラウザに委譲する

## 3. 起動モード

### 3.1 Tauri 通常起動

- 設定ファイル `~/.geocode-web-single/geocode-web-single.env.json` がない場合、初回セットアップ画面を表示する
- セットアップ完了後、設定を保存し、SQLite と初期データを作成し、Axum サーバーを起動する
- 設定ファイルがある場合はその内容でサーバーを起動し、メイン画面を開く
- メインウィンドウ破棄時には Axum サーバーへシャットダウン信号を送る

### 3.2 サーバー単体モード

- `geocode_web_single -s <ADDR>` で起動する
- `<ADDR>` はホストのみ（"0.0.0.0"）またはホスト:ポート（"0.0.0.0:9090"）形式を受け付ける
- ポートが省略された場合は `3000` を使用する
- 例: `-s 0.0.0.0` -> `0.0.0.0:3000`
- 例: `-s 0.0.0.0:9090` -> `0.0.0.0:9090`
- 事前に GUI 起動で設定ファイルを作成済みであることが前提
- Ctrl+C でグレースフルシャットダウンする

## 4. 初回セットアップ

初回セットアップ画面では次を入力する。

- アプリタイトル
- 管理者ユーザー名
- 管理者パスワード
- アカウントロック回数
- 待機制限開始回数
- 待機時間(分)
- アクセストークン有効期限(分)
- リフレッシュトークン有効期限(分)

管理者ユーザー名とパスワードは、デスクトップ版の導入容易性を優先して、どちらも `geocodeweb` を初期値とする。管理者パスワードは8文字以上とし、セットアップ画面で任意の値へ変更できる。

セットアップ完了時に以下を自動生成する。

- 設定 JSON
- SQLite DB ファイル `~/.geocode-web-single/geocode-web.sqlite`
- 画像保存ディレクトリ `~/.geocode-web-single/images`
- ランダムな `SECRET_KEY`

## 5. 設定と保存先

### 5.1 主な設定値

実装上、以下の環境変数相当を設定 JSON から起動時に注入する。

- `APP_TITLE`
- `DATABASE_URL`
- `CREATEDATABASE_PATH`
- `SECRET_KEY`
- `IMAGE_FILES_PATH`
- `UPLOAD_FILE_PATH`
- `FAILED_ACCOUNT_LOCK`
- `NEXT_CHALLENGE_MINUTES`
- `CHALLENGE_LIMIT_TIME_FAILEDCOUNT`
- `ADMIN_USERNAME`
- `ADMIN_PASSWORD`
- `ACCESS_TOKEN_EXP_MINUTUES`
- `REFRESH_TOKEN_EXP_MINUTUES`
- `CACHE_CONTROL`
- `SECURE_COOKIE`
- `SERVICE_NAME`
- `RUST_LOG`
- `ALLOW_USER_CREATE_ACCOUNT`
- `ALLOW_USER_UPDATE_PASSWORD`
- `ALLOW_ORIGINS`
- `TILE_SERVER_BASE_URL`
- `TILE_SERVER_API_KEY`
- `REDIS_URL`
- `REDIS_CONNECT_TIMEOUT_SECONDS`
- `TILE_CACHE_TTL_SECONDS`
- `TILE_CACHE_NAMESPACE`
- `MARKER_FORM_STORAGE_QUOTA_BYTES`（未設定時は1 GiB）
- `LIVE_LOCATION_UPLOAD_INTERVAL_SECONDS`（未設定時は5秒）
- `LIVE_LOCATION_STALE_SECONDS`（未設定時は20秒）
- `LIVE_LOCATION_OFFLINE_SECONDS`（未設定時は120秒）
- `LIVE_MAP_SNAPSHOT_CACHE_SECONDS`（未設定時は2秒）
- `LIVE_MAP_VIEWER_SESSION_MINUTES`（未設定時は720分）
- `LIVE_MAP_PASSWORD_ATTEMPT_LIMIT`（未設定時は5回）
- `LIVE_MAP_PASSWORD_WINDOW_MINUTES`（未設定時は10分）

設定 JSON は `src/model/common.rs` の `ApplicationInitSetup` に対応する。起動時の読み込みは `src/init.rs` の `read_env_json` が行い、環境変数への注入は `src/main.rs` の `apply_env_vars` が行う。

Redisは現在位置共有機能の必須構成ではない。接続がない場合はSQLiteを直接参照し、接続できる場合だけ公開位置スナップショットの短時間キャッシュに使用する。`LIVE_MAP_SNAPSHOT_CACHE_SECONDS=0` では新規キャッシュ保存を無効化する。

### 5.2 設定 JSON の必須項目と任意項目

設定 JSON の項目は、欠落時に起動を止める必須項目と、既定値で補完できる任意項目に分ける。

必須項目:

- `app_title`
- `access_token_exp_minutes`
- `refresh_token_exp_minutes`
- `secret_key`
- `admin_username`
- `admin_passwotd`
- `failed_account_lock`
- `next_challenge_minutes`
- `challenge_limit_time_failed_count`

任意項目:

- `sqlite_database_path`
- `database_url`
- `image_file_path`
- `upload_file_path`
- `cache_control`
- `secure_cookie`
- `service_name`
- `rust_log`
- `allow_user_create_account`
- `allow_user_update_password`
- `allow_origins`
- `tile_server_base_url`
- `tile_server_api_key`
- `redis_url`
- `redis_connect_timeout_seconds`
- `tile_cache_ttl_seconds`
- `tile_cache_namespace`
- `marker_form_storage_quota_bytes`
- `live_location_upload_interval_seconds`
- `live_location_stale_seconds`
- `live_location_offline_seconds`
- `live_map_snapshot_cache_seconds`
- `live_map_viewer_session_minutes`
- `live_map_password_attempt_limit`
- `live_map_password_window_minutes`

任意項目が欠落している場合、`read_env_json` は現在の既定値で補完し、元ファイルを `geocode-web-single.env.json.bak` としてバックアップしたうえで、補完済みの `geocode-web-single.env.json` を保存する。バックアップファイルが既に存在する場合は上書きしない。

JSON として不正な場合、または必須項目が欠落している場合は、自動補完せず起動エラーとする。これにより、管理者認証情報やトークン署名鍵など、推測生成すると既存環境を壊す項目を保護する。

### 5.3 設定項目追加時の更新箇所

新しい設定項目を追加する場合は、必須項目か任意項目かを先に決める。

任意項目として追加する場合:

- `src/model/common.rs`
  - `ApplicationInitSetup` にフィールドを追加する
- `src/init.rs`
  - `ApplicationInitSetupPartial` に `Option<T>` としてフィールドを追加する
  - `EnvDefaults` と `env_defaults` に既定値を追加する
  - `env_json_requires_migration` の移行対象一覧にフィールド名を追加する
  - `complete_env` で既存値優先、欠落時は既定値を使うように追加する
  - `build_env_from_form` で初回セットアップ時の値を設定する
  - `read_env_json` 系のテストに、欠落時補完または既存値維持の確認を追加する
- `src/main.rs`
  - `apply_env_vars` で対応する環境変数へ注入する
- `src/config.rs`
  - `Config` にフィールドを追加し、環境変数から読み込む
  - 任意機能の場合は `ok()` や `unwrap_or` などで安全な既定値を持たせる
- `SPECIFICATION.md`
  - `5.1 主な設定値` と `5.2 設定 JSON の必須項目と任意項目` を更新する

必須項目として追加する場合:

- 任意項目の更新箇所に加えて、`src/init.rs` の `complete_env` で `required!` 対象に追加する
- `env_json_requires_migration` には追加しない。必須項目は欠落時に補完せず、起動エラーとして扱う
- 初回セットアップ画面から入力させる値であれば、`setup/index.html` と `SetupForm`、`build_env_from_form` を更新する
- 既存環境を起動不能にする変更になるため、可能な限り任意項目として安全な既定値を用意できないか検討する

### 5.4 ファイル保存先

- 設定: `~/.geocode-web-single/geocode-web-single.env.json`
- 設定バックアップ: `~/.geocode-web-single/geocode-web-single.env.json.bak`
- DB: `~/.geocode-web-single/geocode-web.sqlite`
- アップロードファイル: `~/.geocode-web-single/images/<先頭5文字>/<uuid_filename>`

## 6. データモデル

### 6.1 `user_model`

- ユーザー ID
- ログインユーザー名
- bcrypt ハッシュ済みパスワード
- 管理者フラグ `is_superuser`
- ログイン失敗回数
- 次回ログイン許可時刻
- ロック状態
- プライバシーモード
- TOTP 一時認証状態
- TOTP 本番シークレット / 仮シークレット
- 現在位置共有許可フラグ `can_share_live_location`（既定値は `false`）

### 6.2 `layer_model` / `marker_info_model`

地図上の情報は「レイヤ」と「マーカー」で管理する。

- `layer_model`
  - レイヤ ID
  - 所有者ユーザー ID
  - レイヤ名
  - マスターレイヤ判定 `is_master`
  - 作成日時 / 更新日時
- `marker_info_model`
  - マーカー ID
  - 所有者ユーザー ID
  - 所属レイヤ ID
  - マーカー名
  - 緯度 / 経度
  - Markdown 形式の詳細本文 `detail`
  - 作成日時 / 更新日時

### 6.3 `image_model`

- 画像 ID
- 所有者ユーザー ID
- 元ファイル名
- UUID ベース保存名
- 作成日時

実ファイルはアップロードディレクトリへ保存する。画像サムネイルや動画 poster は DB には保持せず、同じ UUID stem を持つファイルとして `thumb` サブディレクトリに保存する。

### 6.4 `shape_model`

地図上の図形はレイヤに紐付けて管理する。

- 図形 ID
- 所有者ユーザー ID
- 所属レイヤ ID
- 図形種別 `shape_type`
  - `polygon`
  - `polyline`
  - `rectangle`
  - `circle`
- 図形名 `name`
  - 任意
  - 80 文字以内
- GeoJSON 本文 `geojson`
  - SQLite では TEXT として保存し、バックエンドで `serde_json::Value` との相互変換を行う
- 作成日時 / 更新日時

### 6.5 `temporary_urls`

- 一時 URL ID
- 発行ユーザー ID
- 公開 URL パス
- 有効期限
- 共有パスワードハッシュ
- 共有対象レイヤ一覧(JSON)
- 共有対象マーカー一覧(JSON)
- 共有対象図形一覧(JSON)
- 重ね合わせタイルの共有可否（`include_tile_overlays`）
- 作成日時
- 1 ユーザーにつき保持できる共有 URL は実装上 1 件

### 6.6 `application_settings`

起動後に DB 上で参照されるログイン制限設定。

- `login_attempts_limit`
- `next_challenge_minutes`
- `challenge_limit_start`

### 6.7 `live_location_session`

- `user_id`: TEXT、主キー
- `session_id`: TEXT、共有開始ごとに更新するUUID
- `latitude` / `longitude`
- `accuracy_m` / `heading_deg` / `speed_mps`
- `sequence_no`: 同一セッション内の更新順序
- `observed_at`: ブラウザ側の観測時刻
- `received_at`: サーバー側の最終受信時刻
- `started_at`

1アカウントにつき最新位置を1件だけ保持し、履歴は保存しない。新しい共有開始時は同じ `user_id` の行を更新し、以前の `session_id` からの更新を無効にする。

### 6.8 `live_map`

- `id`: TEXT、主キーとなるUUID
- `public_id`: 公開URLに使用する一意なUUID
- `name` / `created_by`
- `use_tile_overlays`: 重ね合わせタイルを使用するか（既定値true）
- `layers_configured_by`: 公開レイヤを設定した管理者のUUID（TEXT、未設定はnull）
- `password_hash`: 任意の共有パスワードのbcryptハッシュ
- `access_version`: 認証Cookieとキャッシュを無効化する世代番号
- `created_at` / `updated_at` / `expires_at` / `revoked_at`

`revoked_at IS NULL` の行はアプリケーション全体で1件に制限する。期限切れの行は新しい共有マップ作成時に失効させる。

### 6.9 `live_map_member`

- `id`: TEXT、主キーとなるUUID
- `map_id` / `user_id`
- `display_name`: 公開マップ上の表示名
- `marker_color`: `#RRGGBB` 形式の表示色
- `sort_order`

同じマップへ同じユーザーを重複登録できない。

### 6.10 `live_map_password_rate_limit`

- `map_id` / `client_key`: 複合主キー
- `window_started_at` / `attempt_count`

接続元IPアドレスとUser-Agentから生成したキーにより、共有パスワードの試行回数を接続元単位で保持する。

## 7. 認証とセキュリティ

### 7.1 認証方式

- アクセストークンとリフレッシュトークンを JWT で発行する
- 両トークンは HttpOnly Cookie で返却する
- `SameSite=Strict`
- `Secure` は設定に依存する
- リフレッシュトークン Cookie の Path は `/account/refresh`

### 7.2 ミドルウェア

- `CookieValidator`: アクセストークン必須 API 用
- `RefreshCookieValidator`: リフレッシュトークン必須 API 用
- `FlexibleCookieValidator`: トークンがなくても匿名相当で通す静的画像配信用

### 7.3 ログイン制御

- 認証失敗回数は DB 設定に従ってカウントされる
- `challenge_limit_start` 回以上失敗すると一定時間再試行待ちになる
- `login_attempts_limit - 1` 到達時にアカウントはロックされる
- ログイン成功時は失敗回数をリセットする

### 7.4 TOTP

- パスワード認証成功後、TOTP 有効ユーザーは追加トークン入力を求められる
- 一次認証済み状態 `is_basic_authed` は 3 分以内のみ有効
- TOTP 有効化は QR コード提示 -> 6 桁コード検証 -> 本番シークレット昇格の流れ

### 7.5 ファイル配信制御

- 画像ファイルは所有者本人、または所有者がプライバシーモード OFF の場合のみ他者アクセス可
- 静的アセット配信では簡易ファイル名サニタイズを行う
- アップロード許可拡張子は `png/jpg/jpeg/gif/webp/pdf/mp4`
- アップロードサイズは 1 ファイル 100MB まで
- 画像は再エンコードされ、EXIF 等を除去して保存される
- 画像アップロード時はサムネイルを生成する
- MP4 アップロード時はフロントエンドで poster 画像を生成し、サーバーは `thumb/<uuid>.jpg` として保存する
- `/static/images/{image_name}?thumb=true` はサムネイルまたは動画 poster を優先し、存在しない場合は元ファイルへフォールバックする

### 7.6 一時共有 URL の保護

- 共有 URL には任意の共有パスワードを設定できる
- 共有パスワードは 4 文字以上 64 文字以内
- パスワードは bcrypt ハッシュとして `temporary_urls.password_hash` に保存する
- パスワード保護された共有 URL への GET は入力画面を返し、POST で検証成功した場合に共有マップを描画する

### 7.7 現在位置共有マップの保護

- 公開URLはログイン不要とし、必要な場合だけ共有パスワードを設定する
- パスワードは4文字以上、64バイト以内とし、bcryptハッシュだけを保存する
- 認証成功時は署名済みHttpOnly Cookieを発行する。既定の有効期間は12時間で、マップの有効期限を超えない
- パスワード変更・解除、URL再発行、マップ失効では `access_version` を更新し、既存の認証Cookieとキャッシュを無効化する
- 同一接続元のパスワード試行を既定で10分間に5回までに制限する
- 公開ページと位置APIは `Cache-Control: no-store` と `Referrer-Policy: no-referrer` を返す

## 8. 権限モデル

- 管理者: 初期作成される `is_superuser = true` ユーザー
- 一般ユーザー: 通常アカウント

権限の基本ルール:

- すべてのレイヤ・マーカー・画像は所有ユーザー単位で分離され、本人のみ更新・削除できる
- 図形も所有ユーザー単位で分離され、本人のみ作成・更新・削除できる
- マスターレイヤは各ユーザー作成時に自動生成され、名称変更と削除は不可
- 管理系 API は `is_superuser = true` のユーザーのみ利用できる
- 一般ユーザーは自分自身のアカウント設定変更、レイヤ操作、マーカー操作、図形操作、画像操作、共有 URL 発行のみ可能
- 画像の参照は匿名でも到達できるが、実際の返却可否は所有者本人または所有者のプライバシーモード設定で決まる
- 一時共有 URL のレイヤ、マーカー、共有対象に含めた図形は発行時点のスナップショットを参照する。重ね合わせタイルは共有を有効にした場合のみ、作成者の最新の有効な登録情報をページ読込時に参照する

## 9. 主な機能

### 9.1 アカウント

- ログイン
- ログアウト相当: 期限 0 のトークンで Cookie を上書き
- サインアップ
  - `ALLOW_USER_CREATE_ACCOUNT` が true の場合のみ公開
  - 初回セットアップ既定値は false
- パスワード変更
  - `ALLOW_USER_UPDATE_PASSWORD=true` の場合のみ有効
- 自分のユーザー名/ID 取得
- プライバシーモード切替
- TOTP 有効化/無効化

### 9.2 レイヤ管理

- マスターレイヤ ID 取得
- レイヤ一覧取得
- レイヤ追加
- レイヤ名変更
- レイヤ削除
  - ただしマスターレイヤは削除不可

### 9.3 マーカー管理

- マーカー作成
- マーカー一覧取得
- マーカー位置更新
- マーカー名/本文/所属レイヤ更新
- マーカー削除
- マーカー検索
  - マスターレイヤ選択時は全レイヤ横断
  - 個別レイヤ選択時は当該レイヤ内のみ

### 9.4 地図表示・図形描画・データ入出力

- 地図 HTML 表示
  - マーカー指定時は該当地点へフォーカスしズームを上げる
- 別画面用地図 HTML 表示
  - レイヤ一覧と全マーカーをまとめて描画
- 図形表示
  - マスターレイヤ表示時は全レイヤの図形を取得する
  - 個別レイヤ表示時は当該レイヤの図形のみ取得する
  - レイヤ表示/非表示に合わせて図形グループも同期する
- 図形描画
  - ポリゴン / ポリライン / 矩形 / 円を作成できる
  - 作成時に任意の図形名を付けられる
  - 図形名は地図上の常時ラベルとして表示する
  - 図形名、所属レイヤ、図形種別、GeoJSON を後から更新できる
  - ポリゴン / ポリライン / 矩形では頂点の追加・削除・移動、円では中心位置の移動ができる
  - 矩形へ頂点を追加または削除した場合は、図形種別を `polygon` へ更新する
  - 図形を削除でき、削除直後は取り消しできる
  - 作成・更新時はバックエンドでも図形種別と GeoJSON の整合性を検証し、不正な図形は保存しない
- タイルサーバー設定の DB 読み込み
  - 初期データとして国土地理院の通常地図/航空写真を投入
- レイヤ単位または全件(JSON)エクスポート
- Tauri 実行時の JSON エクスポートは Downloads（取得できない場合は Documents）へ直接保存できる
- JSON インポート
  - レイヤ名をもとに新規レイヤを作成し、マーカーと図形を一括登録する
  - v2 形式では `markers` と `shapes` を含むパッケージとして扱う
  - インポートされる各図形にも作成 API と同じ GeoJSON 検証を適用する
  - 不正な図形が1件でも含まれる場合は `400 Bad Request` とし、レイヤ、マーカー、図形を含むトランザクション全体をロールバックする
  - 旧形式のマーカー配列のみの JSON も読み込める

### 9.5 画像/PDF/動画管理

- アップロード
  - 最大 100MB
  - 画像はフロントエンドで縮小処理し、サーバー側で再エンコードする
  - MP4 は可能な場合フロントエンドで poster を生成し、動画本体と一緒に送信する
- 一覧取得
- クライアント側検索
- プレビュー
  - 画像
  - PDF
  - MP4
- 削除
  - 実ファイル、画像サムネイル、動画 poster を削除対象にする
- Markdown 埋め込み文字列の自動生成
  - 画像: `![alt](url)`
  - PDF: `[name](url)`
  - 動画: `?[name](url)` 形式
- Markdown 表示
  - 画像リンクは `?thumb=true` を付けたサムネイル表示に変換する
  - 動画リンクは `poster="{url}?thumb=true"` と `preload="none"` を持つ `<video>` に変換する
  - details 内の画像/動画は展開時に遅延読み込みする

### 9.6 一時共有 URL

- 共有対象レイヤを複数選択して発行できる
- 有効期限(分)を指定して発行できる
  - フロント実装では 10 分以上を要求
- 任意の共有パスワードを設定できる
  - 未入力の場合はパスワード保護なし
  - 4 文字未満または 64 文字超過はエラー
- 共有対象に図形を含めるか選択できる
- 新規発行と既存 URL 更新の 2 モードを持つ
- 現在有効な URL、有効期限、パスワード保護有無を取得できる
- 発行済み URL は削除して共有停止できる
- 共有ページは発行時点のレイヤ/マーカー/図形 JSON をもとに描画する
- 期限切れ URL はアクセス時に削除され、Not Found 画面を返す
- パスワード保護された共有ページは、パスワード入力画面を経由して表示する

#### 9.6.1 一時共有リンクの重ね合わせタイル共有設定

- PC・モバイルの共有設定に「重ねるタイルレイヤも共有する」を設ける。初期値はオフで、新規発行・既存リンク更新時に `include_tile_overlays` を保存する。APIで未指定の場合はfalse
- `temporary_urls.include_tile_overlays` はBOOLEAN NOT NULL DEFAULT 0。起動時のDB移行バージョン12で追加し、既存リンクのみ1へ更新する。移行の再実行では設定を変更しない
- 共有が無効ならタイル情報を渡さずチェック項目も追加しない。有効なら作成者の最新の有効な登録タイルをページ読込時に取得する
- `is_overlay_tile=true` は全タイルを初期表示、`false` はチェックを外して追加する。未指定・不正値は表示する。true/falseは大文字小文字を区別しない
- `is_checked` とは独立して制御する。パスワード入力、認証失敗後の再入力、認証後も指定を維持する。閲覧者のチェック状態は保存しない

### 9.7 管理者機能

- 管理画面 HTML 配信
- ユーザー一覧取得
- 一般ユーザー作成
- ユーザーパスワード再設定
- アカウントロック解除

### 9.8 マーカー入力フォーム

- 所有者はマーカー単位で公開フォームを作成でき、未設定時および初期値は無効とする
- 未設定フォームの既定名にはマーカー名だけを使用する
- フォーム定義は任意HTMLではなく、許可された入力型からなるJSONとして保持する
- 公開URLにはマーカーIDとは別のランダムUUIDを使用し、所有者はURLを再発行できる
- パスワードは任意設定とし、bcryptハッシュのみを保存する
- 匿名投稿はサーバー側でフォーム定義、必須、文字数、選択肢、日付、画像を再検証する
- 回答由来の文字列はMarkdownとしてエスケープし、サーバー生成Markdownのみを原子的に`detail`末尾へ連結する
- 日付は`YYYY-MM-DD`として検証し、Markdownにも同形式で保存する
- 投稿値と生成Markdownは`marker_form_submission_model`にも記録する
- 画像はブラウザで縮小したBlobをmultipart/form-dataで受け付ける。JPEGへ再エンコードして既存画像領域へ保存し、DB本文へ画像バイナリを保存しない
- 設定テーブルと投稿履歴テーブルは対象マーカー削除時にCASCADE削除される

### 9.9 現在位置共有

- `can_share_live_location` が有効なアカウントだけが、自身の位置共有を開始できる
- 利用者の明示操作後、画面が表示されている間だけ既定5秒間隔で送信する
- 管理者は共有許可の切替、共有マップの作成・更新・失効・URL再発行を行える
- 共有マップには1～20アカウントを登録でき、未失効の共有マップはアプリケーション全体で1件だけとする
- 公開マップでは `tileserver_model` の背景地図と、対象ごとの表示・非表示を切り替えられる
- 対象一覧から最新位置へ移動でき、閲覧者自身の現在位置表示と対象名の一括表示も利用できる
- 最終受信から20秒を超える位置は更新遅延、120秒を超える位置はオフラインとして座標を公開しない
- RedisがなくてもSQLiteから公開位置を取得する。Redisがある場合だけ短時間のスナップショットキャッシュを利用する

## 10. 画面仕様

### 10.1 主画面一覧

- 初回セットアップ画面
- 一般ユーザーログイン画面
- 一般ユーザーサインアップ画面（設定有効時のみ導線あり）
- TOTP 入力モーダル
- 地図メイン画面
  - 地図 iframe
  - マーカー一覧テーブル
  - レイヤ切替、検索、各種機能モーダル起動
  - 図形描画ツールパネル
- マーカー編集モーダル
- レイヤ作成/一覧/名称変更/削除確認モーダル
- 画像アップロード/一覧/プレビュー/削除確認モーダル
- JSON インポートモーダル
- 一時共有 URL 設定/表示モーダル
- パスワード保護された一時共有 URL のパスワード入力画面
- ユーザー設定モーダル
  - プライバシーモード切替
  - TOTP 有効化/無効化
  - 設定有効時のみパスワード変更を表示
- 管理者ログイン画面
- 管理ユーザー一覧画面
  - 一般ユーザー作成
  - パスワードリセット
  - アカウントロック解除
  - 現在位置共有許可の切替
- 管理者の現在位置共有マップ管理画面
- 現在位置共有マップ公開画面
- 現在位置共有マップの共有パスワード入力画面

### 10.2 初回セットアップ画面

- Tauri カスタムプロトコル `app-setup://index` で配信
- サーバー未起動状態でも表示可能

### 10.3 モバイル向け表示

- `User-Agent` に `Mobile` を含む場合、`/index` は `index-mobile.html` を返す
- `/map` および `/onetime/{url_id}` でも同様にモバイル専用テンプレートへ切り替える
- モバイル UI は地図を全画面寄りに表示し、機能群はフローティングボタンと全画面モーダル中心で操作する
- デスクトップ版の左右 2 カラム構成に対し、モバイル版はツール表示と一覧表示を重ね合わせる構成を採る
- HTTPS または localhost では共有 URL やファイルリンクをクリップボードへ直接コピーできる
- 現在位置共有マップは地図を全画面表示し、共有対象一覧を地図下部の横スワイプ式カードとして重ねる
- 現在位置共有マップではタイトルを非表示とし、対象が4件以上の場合はレイヤ一覧を「すべて表示」「折り畳む」で切り替える

## 11. API 概要

### 11.1 認証不要

- `GET /`
- `GET /index`
- `GET /health-check`
- `GET /app-init`
- `GET /favicon.ico`
- `GET /assets/{uri}`
- `POST /account/token`
- `POST /account/totp/token`
- `GET /onetime/{url_id}`
- `POST /onetime/{url_id}` (共有パスワード検証)
- `GET /images/html/{image_name}`
- `GET /licanses`
- `POST /account/signup` (`ALLOW_USER_CREATE_ACCOUNT=true` の場合のみ)
- `GET /live/{public_id}`
- `POST /live/{public_id}/authenticate`
- `GET /live-api/maps/{public_id}/positions`

### 11.2 アクセストークン必須

- `GET /map`
- `GET /map-another`
- `GET /account/auth`
- `GET /images/eneble-images`
- `GET /images/eneble-images/{limit}`
- `POST /images/upload`
- `DELETE /images/delete/{image_id}`
- `POST /layer`
- `GET /layer/masterid`
- `GET /layer/read/all`
- `DELETE /layer/delete/{layer_id}`
- `PUT /layer/update/{layer_id}`
- `POST /marker`
- `GET /marker/read/all`
- `DELETE /marker/delete/{marker_id}`
- `PUT /marker/update-marker-latlng`
- `PUT /marker/update/{marker_id}`
- `GET /marker/read/query`
- `GET /shapes`
- `POST /shape`
- `PUT /shape/{shape_id}`
- `DELETE /shape/{shape_id}`
- `GET /file/export/{layer_id}`
- `POST /file/import`
- `GET /admin`
- `GET /admin/users`
- `POST /admin/user/password-reset/{update_user_id}`
- `POST /admin/user/unlock/{unlock_user_id}`
- `POST /admin/user/create`
- `POST /onetimeurl/generate`
- `GET /onetimeurl/current`
- `DELETE /onetimeurl/delete/{id_url}`
- `POST /live-location/session`
- `PUT /live-location/session/{session_id}`
- `DELETE /live-location/session/{session_id}`
- `POST /live-location/session/{session_id}/stop`
- `GET /admin/live-locations`
- `PUT /admin/users/{user_id}/live-location-permission`
- `GET /admin/live-map-layers`: 操作中の管理者が所有する非masterレイヤ候補
- `GET /admin/live-maps`
- `POST /admin/live-maps`
- `PUT /admin/live-maps/{map_id}`
- `DELETE /admin/live-maps/{map_id}`
- `POST /admin/live-maps/{map_id}/rotate-url`
- `GET /account/info`
- `POST /account/password-update`
  - `ALLOW_USER_UPDATE_PASSWORD=true` の場合のみルート登録
- `PUT /account/privacy`
- `GET /account/totp/setup`
- `POST /account/totp/verify`
- `GET /account/totp/disable`
- `GET /account/token/disable`

### 11.3 リフレッシュトークン必須

- `POST /account/refresh`

### 11.4 匿名許容

- `GET /static/images/{image_name}`
  - ただし実際の返却可否は所有者のプライバシーモードで判定

### 11.5 図形 API の GeoJSON 検証

`POST /shape`、`PUT /shape/{shape_id}`、`POST /file/import` では、DB へ書き込む前に以下を検証する。

- 共通
  - ルートの `type` は `Feature`
  - `geometry` と `coordinates` が存在する
  - `shape_type` と `geometry.type` が一致する
  - 座標は数値で、経度は -180～180、緯度は -90～90 の範囲
- `polygon`
  - `geometry.type` は `Polygon`
  - 各リングは閉じており、閉じ座標を除いて異なる3頂点以上
- `polyline`
  - `geometry.type` は `LineString`
  - 2頂点以上
- `rectangle`
  - `geometry.type` は `Polygon`
  - 1つのリングに異なる4頂点と閉じ座標の合計5座標
- `circle`
  - `geometry.type` は `Point`
  - `properties.radius` は正の有限値

更新 API の `shape_type` と `geojson` は任意項目である。いずれかが指定された場合、指定されなかった側は DB の既存値を使用し、更新後の組み合わせとして検証する。検証に失敗した場合は `400 Bad Request` を返し、更新 SQL は実行しない。

### 11.6 現在位置共有 API

位置ペイロードは緯度、経度、精度、進行方向、速度、観測時刻、連番を持つ。緯度・経度の範囲、非負の精度・速度、0～360度の進行方向、非負の連番、サーバー時刻との差が24時間以内の観測時刻を検証する。同一セッションでは連番が増加する更新だけを受け付け、受信間隔を1秒以上に制限する。

ユーザー向けAPIは位置共有セッションの開始、更新、停止を提供する。`GET /account/auth` の `can_share_live_location` でログイン中アカウントの共有可否を返す。

管理者向けAPIは、共有許可済みユーザーと最新位置の取得、共有許可の変更、固定URLを持つ共有マップの作成・取得・更新・失効・URL再発行を提供する。

公開位置APIはマップ情報、サーバー時刻、更新間隔、共有対象の最新状態を返す。Redis接続を取得できた場合は `access_version` を含むキーへ短時間キャッシュし、接続がない場合やRedis操作に失敗した場合はSQLiteから取得して応答を継続する。

## 12. エラー応答

API エラーは原則 JSON で返る。

```json
{
  "error": "..."
}
```

主なステータス:

- `400 Bad Request`
- `401 Unauthorized`
- `404 Not Found`
- `409 Conflict`
- `415 Unsupported Media Type`
- `500 Internal Server Error`

## 13. 既知の実装上の挙動

- ユーザー自己登録は設定値で制御され、初回セットアップ既定では無効
- 画像プライバシーはファイル単位ではなくユーザー単位
- 一時 URL は Wiki の live データではなく、発行時点のタイトル/本文/共有対象に含めた図形を保持する
- 共有 URL に図形を含めるかどうかは共有作成時の選択に依存する
- JSON エクスポートは v2 パッケージ形式だが、旧形式のマーカー配列もインポートできる
- フロントエンドは JST 前提の表示補正を複数箇所で行う
- `SECURE_COOKIE=true` が既定のため、HTTP 運用時は設定変更が必要
- ブラウザの位置情報APIはHTTPSまたはlocalhostで利用する。通常のTauri起動は同一PC向けであり、別端末へ公開する場合はサーバー単体モードとHTTPS対応のリバースプロキシを使用する
- Redisは任意であり、未設定・未接続でも現在位置共有を含む主要機能はSQLiteだけで動作する

## 14. 配布物

- Tauri バンドル対象: Windows NSIS
- 組み込み静的ファイル: `dist/`
- 組み込みテンプレート: `dist/templates/`

## 15. GitHub Release Workflow

本リポジトリには Windows 向けリリースビルド用の GitHub Actions workflow として `.github/workflows/release.yml` を持つ。

### 15.1 トリガー

- `v*` タグ push
- `workflow_dispatch`

### 15.2 ビルド時前提

- 実行環境は `windows-latest`
- ビルド前に workflow がルートへ CI 用 `.env` を生成する
- `.env` には少なくとも次の値を設定する
  - `DATABASE_URL`
  - `CREATEDATABASE_PATH`
  - `VITE_IP_ADDRESS`
  - `VITE_ASSET_PATH`
- `sqlx` のコンパイル時クエリ検証を通すため、workflow 内で `sqlx-cli` を導入し、`sqlx database create` と `sqlx migrate run` を実行して CI 用 SQLite DB を作成する

### 15.3 ビルド処理

- `npm ci` を `frontend`、`frontend-mobile`、`frontend-admin`、`template-scripts` で実行する
- `frontend` と `template-scripts` のテスト、全4プロジェクトの型検査・ビルドを実行する
- `src_frontend/scripts/frontends-builder.ps1 -SkipCargoBuild` でフロントエンド成果物を `dist/` に集約する
- `cargo tauri build` で Windows インストーラを生成する
- `target/release/bundle` 配下の `.exe` / `.msi` を成果物として収集する

### 15.4 リリース処理

- 収集済み成果物をまとめてダウンロードする
- SHA-256 チェックサム `checksums.txt` を生成する
- GitHub Release を draft で作成し、成果物とチェックサムを添付する

## 16. ライブマップのタイル・レイヤ公開

SQLite版はPostgreSQL版と同じテンプレート・フロントエンドを使用し、以下の仕様を提供する。

### 16.1 重ね合わせタイルの使用可否・初期表示

- 管理画面の作成・編集設定に「重ねるタイルレイヤを使用する」を設け、`live_map.use_tile_overlays` に保存する。既定値とAPI未指定時はtrue。管理画面を開き直すと保存値を復元する
- `20260912120000_add_use_tile_overlays_to_live_map.sql` で既存マップもtrueとして移行する。URL再発行では値を維持する
- falseの場合は公開ページへタイル情報を渡さず専用コントロールを設置しない。クエリパラメータで使用可否を上書きできない
- trueの場合のみマップ作成者の最新の有効な登録タイルを参照する。他の管理者による編集でも作成者は変わらない
- 使用可否は保存後に有効となり、公開ページの再読み込み時に反映する。保存済み設定がfalseの場合、管理画面の「重ね合わせタイルを初期表示する」を無効化し、生成URLの `is_check_overlay` はfalseとする

以下は使用設定がtrueの場合の初期表示制御。

ライブマップはマップ作成者である管理者の登録済み・有効なタイルを専用コントロールに表示する。初期チェック状態は `is_check_overlay` クエリパラメータで指定する。

| 値 | 初期状態 |
| --- | --- |
| `true`（大文字・小文字を区別しない） | 全タイルをチェックして表示 |
| `false`、未指定、その他の値 | 全タイルのチェックを外して非表示 |

- 非表示時もコントロールに項目を残し、閲覧者が個別にチェックして表示できる。非表示のタイル画像は読み込みを開始しない
- 管理画面の共有URL欄に「重ね合わせタイルを初期表示する」を設ける。初期値はオフで、URL表示・コピー・別タブで開く操作に `is_check_overlay=true/false` を反映する
- このURL設定はDB・ローカルストレージへ保存しない。共有アカウントの表示状態には影響しない
- パスワード入力画面の送信先、認証失敗時の再入力、認証成功後のリダイレクトに指定を引き継ぐ。位置取得中に認証が切れて公開ページへ戻る場合も初期指定を維持する

### 16.2 モバイルのコントロール表示切り替え

- 幅700px以下では「地図だけを表示」ボタンを表示し、押すと「機能を表示」に切り替わる。初期状態はコントロール表示とする
- 非表示対象はタイルサーバ切り替え、共有アカウントのチェック、重ね合わせタイルのチェック、公開レイヤ（マーカー・図形）のチェックとする
- 「現在位置へ移動」「名前を表示／名前を隠す」、下部の横スワイプ式アカウントカード、復帰用ボタン、ズーム、出典表示は残す
- コントロールの外観だけを隠し、背景地図・各レイヤのチェック・折りたたみ状態を維持する。位置更新、名前表示、カードからの位置移動も継続する
- PC幅では対象コントロールを表示して切り替えボタンを隠す。同じページでモバイル幅に戻すと直前の選択状態を反映する
- 表示切り替え状態はURL・ローカルストレージへ保存しない。`is_check_overlay` によるタイル自体の初期表示とは独立する
- 左下の「地図だけを表示／機能を表示」と「現在位置へ移動」は横並びに配置し、出典との重なりを避けるため下端から `8px + env(safe-area-inset-bottom)` 上げる。下部カードは下端から `56px + env(safe-area-inset-bottom)` の位置に置く

### 16.3 管理者のレイヤ（マーカー・図形）の公開

- 管理画面の「レイヤ（マーカー・図形）を追加」から、操作中の管理者が所有するレイヤを「レイヤ名」「追加」のテーブルで選択する。`master` は候補に含めず、APIでも拒否する
- モーダルの「選択を適用」は編集中の設定に反映するだけで、共有マップの作成・更新時に保存する。キャンセルはモーダル内の変更を破棄する。全解除して適用・保存すると公開レイヤをなくせる
- `GET /admin/live-map-layers` は操作中の管理者の候補だけを返す。一般ユーザーは利用不可
- 共有マップ作成・更新APIの `layer_ids` が未指定（またはnull）の場合は既存の公開設定を維持する。配列指定時は所有者・存在・master以外であること・重複がないことを検証し、設定更新と同じトランザクションで全件置換する。空配列は全解除
- `live_map.layers_configured_by` に選択した管理者を記録し、`live_map_layer(map_id, layer_id)` に選択を保存する。組み合わせを主キーとし、地図・レイヤ削除時に関連行を削除する。設定者削除時は設定者をnullとする
- `20260913000000_add_live_map_layers.sql` で追加する。既存・新規マップの初期値は公開レイヤなし。URL再発行でも選択を維持する
- 別の管理者は自分のレイヤで設定を上書きできる。他の管理者の選択内容は管理APIの `layer_ids` に含めず、`layers_configured_by_other` でその旨を通知する。選択に触れず通常設定だけ保存した場合は上書きしない
- 重ね合わせタイルの参照元である `created_by` は変更しない
- 公開ページ読込時に、設定者が所有する選択済みの非masterレイヤと、その最新のマーカー・図形を一貫したDBスナップショットから取得する。master直下・未選択レイヤのオブジェクトは公開しない。パスワード・有効期限・失効の既存制御を適用する
- 公開レイヤはアカウント・タイルとは独立したコントロールで初期表示する。マーカーアイコン、名称、Markdownメモ、図形の形状・色・線種・矢印を閲覧専用で表示する。添付ファイルは既存のアクセス制御を利用する
- 表示中の公開レイヤのマーカーを共通のクラスタグループに集約する。レイヤのチェック切り替えで対象を更新し、図形と共有アカウントの現在位置はクラスタに含めない
- 位置情報の定期更新とは分離し、ページ再読込で最新設定・内容を反映する。専用クエリパラメータやローカルストレージ保存は設けない
- モバイルの「地図だけを表示」では公開レイヤのコントロールも隠す。レイヤ自体の表示やアカウントカードの動作は維持する

### 16.4 SQLiteでの保存・移行

- `src/db/pool.rs` のマイグレーション13で `use_tile_overlays`、14で `layers_configured_by` と `live_map_layer` を追加する。CLI用SQLファイルにも同じ定義を用意する
- IDはTEXTのUUID、真偽値はSQLiteの整数表現で保存する。`live_map_layer` の主キーは `(map_id, layer_id)`、地図・レイヤ削除時はCASCADE、設定者削除時はSET NULLとする
- 作成・更新は `BEGIN IMMEDIATE` で書き込み権を確保してから選択を検証・置換する。公開ページの取得は読み取りトランザクション内で統一したスナップショットを読む
- 有効期限は `julianday` で比較し、SQLite形式とRFC 3339形式の両方を同じ日時として判定する
- 公開マーカーはクラスタ化し、画像をクリックしてもプレビューを開かない。PC・モバイルのポップアップ本文幅と余白は通常地図に揃える

以上が、現行実装に基づく GeoCode-Web-SingleBin の仕様である。
