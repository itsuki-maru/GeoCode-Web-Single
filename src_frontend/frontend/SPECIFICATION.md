# PC UI 仕様

## 1. 概要

PC用のVueアプリ。地図オブジェクト一覧、レイヤ、画像・動画・PDF、アカウント、共有、印刷の操作を提供する。地図本体はバックエンドの `/map` をiframeで表示する。

関連: [全体構成](../SPECIFICATION.md)、[モバイル](../frontend-mobile/SPECIFICATION.md)、[地図スクリプト](../template-scripts/SPECIFICATION.md)、[機能・API仕様](../../SPECIFICATION.md)。

## 2. ディレクトリ構成

```text
frontend/
├── index.html                  ViteのHTML入口
├── public/                     アイコン・manifest・地図共通CSS等
├── scripts/                    vendor配置、印刷PDF確認
├── src/
│   ├── main.ts / App.vue        起動・アプリ枠
│   ├── router/                 画面遷移、API URL定義
│   ├── views/                  トップ・地図・認証画面
│   ├── components/             機能別UI部品
│   ├── stores/                 Piniaのアプリ状態・API操作
│   ├── composables/            画像処理、選択レイヤ、表示状態等
│   ├── assets/                 ソースから参照するスタイル等
│   ├── axiosClient.ts          Cookie付きAPI通信・認証更新
│   ├── interface.ts            UI側データ型
│   ├── setting.ts              Vite環境変数の参照
│   └── test/                   テスト共通設定
├── tests/template-js/          地図・Teraとの接続テスト
└── dist/                       個別ビルド成果物（生成物）
```

`src/**/__tests__/` は対象実装に対応するテスト。ディレクトリ内のメモや雛形ファイルの存在は、画面から利用されていることを意味しない。参照元はrouter・views・importで確認する。

## 3. 起動と画面遷移

[main.ts](src/main.ts) はPiniaとRouterを登録し、`appInits.init()` の完了後にマウントする。現実装は `finally` 内でもinitを呼び出すため、初期設定取得を再度開始する。`App.vue` が地図画面へ遷移させる。

| Vue内パス | 画面 | 処理 |
| --- | --- | --- |
| `/` | `AppTop.vue` | トップ用ルート |
| `/mapview` | `MapView.vue` | 認証確認後、マーカー・レイヤ・画像の取得を開始 |
| `/account/login` | `auth/LoginView.vue` | ログイン・TOTP認証 |
| `/account/signup` | `auth/SignupView.vue` | アカウント登録 |

地図ルートは `/account/auth` の失敗時にloginへ遷移する。ルートガード内の各 `initList()` は呼び出し後に待機せず遷移を進めるため、一覧取得完了を保証するガードではない。図形の取得は地図画面側でも行う。

`/app-init` の `app_title`、`allow_user_account_create`、`allow_user_update_password`、`allow_origins` をUI設定として使用する。実際の操作可否はバックエンドでも検証される。

Service Workerはload時に登録する。`public/service-worker.js` に特別なfetchキャッシュ処理はなく、オフライン地図機能を提供するものではない。

## 4. 画面と主要機能

地図画面の連携をまとめる実装は [MapView.vue](src/views/MapView.vue)。

| 配置 | 主な責務 |
| --- | --- |
| `components/map/` | ツールバー、地図iframe、全画面表示、印刷モーダル |
| `components/map-object/` | マーカー・図形の統合一覧、詳細編集、公開入力フォーム設定 |
| `components/layer/` | レイヤ作成・一覧・改名、マーカーアイコン、重ね合わせタイル選択 |
| `components/image/` | ファイル一覧、アップロード、プレビュー |
| `components/share/` | 一時共有URLの設定・発行・表示 |
| `components/qrcode/` | QRコード表示 |
| `components/location/` | 現在位置共有セッションの制御 |
| `components/json/` | JSONインポート用UI |
| `components/site/` | 外部サイトURL設定 |
| `components/UserPrivacySetting.vue` | プライバシー、パスワード、TOTP等のアカウント設定 |
| `components/common/` | 確認・通知・進捗・モーダル枠 |

地図の図形描画・計測・検索はiframe側で実装する。一覧からの選択や編集結果はiframeへ通知する。印刷は `/map-another?print=1` の専用iframeを使用し、現在の地図状態と対象レイヤを引き渡す。

### PCとモバイルの主な差

| 項目 | PC | モバイル |
| --- | --- | --- |
| Vue入口 | `main.ts` / `App.vue` | `mainMobile.ts` / `AppMobile.vue` |
| 地図高さ | MapIframeのheightをvhとして適用 | MapIframeは100vh |
| 印刷モーダル | あり | 対応コンポーネントなし |
| JSONインポート専用モーダル | あり | 対応コンポーネントなし |
| 外部サイト設定コンポーネント | あり | 対応コンポーネントなし |
| 一覧開閉の永続化composable | あり | 対応composableなし |
| 編集地図 | PC用profile | タップ向けprofile |

これは現行ソースの実装差であり、バックエンドAPIの可否を表す表ではない。

## 5. 状態管理

| ストア | 責務・取得元 |
| --- | --- |
| `appInits` | `/app-init` のアプリ設定 |
| `auth` | UI認証状態、再認証中・トークン更新中フラグ |
| `layers` | `/layer/read/all`、レイヤ更新・削除 |
| `mapobjects` | マーカーMap、統合検索結果の図形ID、マーカー更新・削除 |
| `shapes` | `/shapes` の図形Map、名前・レイヤ・GeoJSON更新 |
| `images` | 初期50件・検索50件のファイル一覧 |
| `markerIcons` | マーカーアイコンの取得・検索等 |

Piniaの内容はAPIデータをUIで扱うためのメモリ上の状態であり、DBの代わりではない。統合検索は `/map-objects/read/query` の `markers` と `shape_ids` を使う。データ更新後は、操作に応じてストア更新、再取得、iframeの部分更新・再読み込みを行う。

### ブラウザ保存

- `geocode-web:last-active-layer-id`: 最後の選択レイヤ。現在利用できる一覧に存在しなければmasterへ戻す。
- `geocode-web:map-object-table-open`: 一覧の開閉。未設定時は開く。
- `loginuser` / `loginUser`: ログイン画面が保持するユーザー関連値。大文字小文字の異なるキーが存在する。
- 地図の中心・表示設定・タイルの状態は [地図スクリプト仕様](../template-scripts/SPECIFICATION.md) を参照。

選択レイヤ・一覧開閉キーにアカウントIDは含まれない。ログイン状態の最終判断はAPIで行う。

## 6. API・認証・iframe連携

[router/urls.ts](src/router/urls.ts) が主なAPI URLを定義する。一部コンポーネントはURLを直接組み立てるため、定数一覧だけをAPI利用一覧としない。

[axiosClient.ts](src/axiosClient.ts) は `withCredentials: true` を設定する。FormDataの場合はContent-Typeを削除してブラウザにboundary設定を任せ、その他はJSONとする。

401の `token_expired` は `/account/refresh` を呼び、並行リクエストで更新Promiseを共有して元の要求を再試行する。更新失敗・`refresh_token_expired` はログアウト状態にしてログインへ遷移する。再認証・トークン切り替え中は先行遷移を抑止する。すべての401を同じエラーとして扱うわけではない。

[MapIframe.vue](src/components/map/MapIframe.vue) はfocus、絞り込み、更新、削除、タイル変更を送信し、画像表示・再読み込み・ログイン遷移・位置情報・印刷開始を受信する。送信先originはiframe URLから算出する。受信は許可originに加えiframeのcontentWindowとの一致を検証する。

更新要求はrequestIdで応答を対応付け、2秒でfalseを返す。地図画面側は反映できなかった場合の再読み込みを処理する。完全なメッセージ一覧と印刷通信は [スクリプト仕様](../template-scripts/SPECIFICATION.md) を参照。

## 7. 開発・配布・テスト

このディレクトリで実行する:

```sh
npm ci
npm run dev
npm run type-check
npm run test:run
npm run test:template-js
npm run build
```

`build-only` はViteビルド後に [copy-vendor-assets.mjs](scripts/copy-vendor-assets.mjs) を実行する。この処理が他の地図画面にも必要なvendor資材を供給する。`dist/` の統合・Rustへの組み込みは [全体仕様](../SPECIFICATION.md) の手順を使用する。

`src/**/__tests__/` は認証、router、ストア、composable、モーダル、iframe、位置共有などを検証する。`tests/template-js/` はtemplate-scriptsとTera、vendorをまたぐ契約・スモーク・印刷テストを含む。

印刷PDFの任意確認は `scripts/check-print-preview.mjs` と `scripts/check-print-preview-pdfs.py` を使用する。ブラウザ・Playwright・Python等の別途準備が必要で、詳細な実行例は [README](../../README.md) を参照する。

## 8. 変更時の注意

- UI型は [interface.ts](src/interface.ts)、地図型はtemplate-scripts、API型はRustに分かれている。データ変更時はそれぞれ照合する。
- iframeのメッセージ名はモバイルと一部異なる。受信側と送信側を同時に確認する。
- ルートガードは認証確認であり、各データ取得の完了・成功を一括保証しない。
- lint/formatは修正を伴うスクリプトである。閲覧・確認だけの目的で実行しない。
