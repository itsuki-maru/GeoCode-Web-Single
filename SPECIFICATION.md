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

### 5.2 ファイル保存先

- 設定: `~/.geocode-web-single/geocode-web-single.env.json`
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
- 図形名 `name`
  - 任意
  - 80 文字以内
- GeoJSON 本文 `geojson`
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
- 作成日時
- 1 ユーザーにつき保持できる共有 URL は実装上 1 件

### 6.6 `application_settings`

起動後に DB 上で参照されるログイン制限設定。

- `login_attempts_limit`
- `next_challenge_minutes`
- `challenge_limit_start`

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
- 一時共有 URL で参照できるのは発行時点で選択されたレイヤ、マーカー、共有対象に含めた図形のスナップショットのみ

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
  - ポリゴン / ポリライン / 矩形を作成できる
  - 作成時に任意の図形名を付けられる
  - 図形名は地図上の常時ラベルとして表示する
  - 図形名と所属レイヤを後から更新できる
  - 図形を削除でき、削除直後は取り消しできる
- タイルサーバー設定の DB 読み込み
  - 初期データとして国土地理院の通常地図/航空写真を投入
- レイヤ単位または全件(JSON)エクスポート
- Tauri 実行時の JSON エクスポートは Downloads（取得できない場合は Documents）へ直接保存できる
- JSON インポート
  - レイヤ名をもとに新規レイヤを作成し、マーカーを一括登録する
  - v2 形式では `markers` と `shapes` を含むパッケージとして扱う
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

### 9.7 管理者機能

- 管理画面 HTML 配信
- ユーザー一覧取得
- 一般ユーザー作成
- ユーザーパスワード再設定
- アカウントロック解除

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

### 10.2 初回セットアップ画面

- Tauri カスタムプロトコル `app-setup://index` で配信
- サーバー未起動状態でも表示可能

### 10.3 モバイル向け表示

- `User-Agent` に `Mobile` を含む場合、`/index` は `index-mobile.html` を返す
- `/map` および `/onetime/{url_id}` でも同様にモバイル専用テンプレートへ切り替える
- モバイル UI は地図を全画面寄りに表示し、機能群はフローティングボタンと全画面モーダル中心で操作する
- デスクトップ版の左右 2 カラム構成に対し、モバイル版はツール表示と一覧表示を重ね合わせる構成を採る
- HTTPS または localhost では共有 URL やファイルリンクをクリップボードへ直接コピーできる

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

- `npm ci` を `frontend`、`frontend-mobile`、`frontend-admin` で実行する
- `src_frontend/scripts/frontends-builder.ps1` でフロントエンド成果物を `dist/` に集約する
- `cargo tauri build` で Windows インストーラを生成する
- `target/release/bundle` 配下の `.exe` / `.msi` を成果物として収集する

### 15.4 リリース処理

- 収集済み成果物をまとめてダウンロードする
- SHA-256 チェックサム `checksums.txt` を生成する
- GitHub Release を draft で作成し、成果物とチェックサムを添付する

以上が、現行実装に基づく GeoCode-Web-SingleBin の仕様である。
