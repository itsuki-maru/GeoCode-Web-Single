# モバイル UI 仕様

## 1. 概要

モバイル専用のVueアプリ。PC版とは別のビルド・コンポーネント・ストアを持つ。バックエンドがUser-Agentに `Mobile` を含む場合にモバイルHTMLを選択する。画面幅だけでPCアプリから切り替わる構成ではない。

関連: [全体構成](../SPECIFICATION.md)、[PC版と機能差](../frontend/SPECIFICATION.md)、[地図スクリプト](../template-scripts/SPECIFICATION.md)、[Tera](../../src/templates/SPECIFICATION.md)。

## 2. ディレクトリ構成

```text
frontend-mobile/
├── index.html / public/       HTML入口・アイコン・manifest等
├── src/
│   ├── mainMobile.ts          Pinia・Router登録、初期設定取得
│   ├── AppMobile.vue          アプリ枠、ヘッダー、メモ表示
│   ├── router/               Vueルート・API URL
│   ├── views/                地図・トップ・ログイン・登録
│   ├── components/           map、map-object、layer、image、share等
│   ├── stores/               appInits、auth、layers、mapobjects等
│   ├── composables/          最終レイヤ、画像処理、図形中心等
│   ├── assets/               スタイル等
│   ├── axiosClient.ts        API通信・認証更新
│   ├── settingMobile.ts      API・資材の環境変数
│   ├── interface.ts          UIのデータ型
│   └── test/                 テスト共通設定
└── dist/                     個別ビルド成果物（生成物）
```

テストは `src/**/__tests__/` に配置する。

## 3. 起動と画面遷移

[mainMobile.ts](src/mainMobile.ts) は `/app-init` の取得終了後にマウントする。現実装ではfinally内でもinitを再度呼ぶ。[AppMobile.vue](src/AppMobile.vue) が `/mapview` に遷移し、ヘッダー・メモアイコンの表示状態をprovideする。地図画面はこれらをinjectして利用する。

| Vue内パス | 画面 | 挙動 |
| --- | --- | --- |
| `/` | `AppTopMobile.vue` | トップ用ルート |
| `/mapview` | `MapViewMobile.vue` | `/account/auth` 成功後に一覧取得を開始 |
| `/account/login` | `auth/LoginViewMobile.vue` | 通常ログイン・TOTP認証 |
| `/account/signup` | `auth/SignupViewMobile.vue` | アカウント登録 |

地図ルートの認証失敗はloginへ遷移する。ルート内のマーカー・レイヤ・画像初期取得は開始後に待機せず画面遷移する。図形取得は地図画面側でも実施する。バックエンドへの直接アクセスとVue内遷移の違いは [全体仕様](../SPECIFICATION.md) を参照。

Service Workerを登録するが、fetchの特別なキャッシュ処理はない。manifestの配置のみからオフライン利用を想定しない。

## 4. 画面・機能

[MapViewMobile.vue](src/views/MapViewMobile.vue) が、ツールバー、統合一覧、地図、各モーダル、位置共有を接続する。

| 配置 | 役割 |
| --- | --- |
| `components/map/` | ツールバー、100vhの地図iframe、全画面地図、画像表示関連 |
| `components/map-object/` | マーカー・図形の一覧、編集、公開フォーム設定 |
| `components/layer/` | レイヤの作成・選択・改名、アイコン、タイル選択 |
| `components/image/` | アップロード、一覧、プレビュー |
| `components/share/`・`qrcode/` | 一時共有URL設定・表示、QRコード |
| `components/location/` | 現在位置の共有開始・停止など |
| `components/UserPrivacySetting.vue` | アカウント設定 |
| `components/common/` | モーダル枠、通知、確認、進捗 |

PC版の印刷モーダル、JSONインポート専用モーダル、外部サイト設定コンポーネントはこのプロジェクトにはない。PC固有機能を追加・変更する際は、モバイルにも実装があると仮定しない。

地図描画・編集は `/map` が返す `map-mobile.html` と `template-map-mobile.js` が担当する。編集profileによりタップ向け文言・判定・更新差を切り替える。Vue側のMapIframeとTera側のモバイル地図UIは別の責務である。

## 5. 状態・API

| ストア | 内容 |
| --- | --- |
| `appInits` | タイトル、登録・パスワード変更許可、許可origin |
| `auth` | UI認証状態、再認証・トークン切り替え中フラグ |
| `layers` | レイヤ一覧と更新操作 |
| `mapobjects` | マーカーと統合検索の図形ID |
| `shapes` | 図形データ、GeoJSON等の更新 |
| `images` | 初期50件・検索結果のファイル一覧 |
| `markerIcons` | マーカーアイコン一覧・検索等 |

主なAPI URLは [router/urls.ts](src/router/urls.ts)、データ型は [interface.ts](src/interface.ts)。ストアはPCと別ファイルなので、フィールドや更新方法の変更は両方確認する。

[axiosClient.ts](src/axiosClient.ts) はCookie付き通信を行い、FormDataのContent-Typeはブラウザに任せる。401 `token_expired` は共有Promiseで `/account/refresh` を実行し再試行する。更新失敗・refresh期限切れはログインへ戻す。再認証・トークン切り替え中は先行遷移を抑止する。

`useLastActiveLayer` はlocalStorageの `geocode-web:last-active-layer-id` を使い、利用可能なレイヤに存在しなければmasterへ戻す。キーはPCと同名でアカウントIDを含まない。ログイン画面には `loginuser` / `loginUser` キーも存在する。地図側の保存値は [地図仕様](../template-scripts/SPECIFICATION.md) を参照する。

## 6. iframe連携

[MapIframe.vue](src/components/map/MapIframe.vue) は `focus`、`mapObjectFilter`、`mapObjectUpdate`、`mapObjectDelete`、`tileOverlaysUpdate` を送信する。更新系要求はrequestIdで対応付け、2秒で未応答をfalseにする。画面破棄時は待機中要求を解除する。

受信する通知は再読み込み、ログイン遷移、画像表示、現在位置、更新結果。画像通知はPCの `callParentFunction` と異なり **`callParentImagePreview`** を使う。印刷開始通知のハンドラーは持たない。

送信先はiframe URLのorigin、受信はapp-init由来の許可originとiframeのcontentWindowの両方で検証する。位置情報を利用するiframeには `allow="geolocation"` を設定する。完全なデータ形式は [メッセージ仕様](../template-scripts/SPECIFICATION.md) を参照する。

## 7. 開発・ビルド・検証

このディレクトリで実行する:

```sh
npm ci
npm run dev
npm run type-check
npm run test:run
npm run build
```

`settingMobile.ts` は `VITE_IP_ADDRESS` と `VITE_ASSET_PATH` を参照する。Viteはルートの環境変数を読み、個別成果物は `dist/index.html`。統合時に `index-mobile.html` に改名する。地図のvendor資材はPC側のビルドが供給するため、配布には [統合手順](../SPECIFICATION.md) を使用する。

既存テストはrouter、Axios、ストア、画像処理、モーダル、iframe、位置共有などを対象とする。モバイル地図の描画・entryの連携テストはtemplate-scriptsおよびPC側 `tests/template-js/` にも存在する。

タッチ・ペン入力、画面回転、位置情報の許可、アップロードと動画再生などは実端末での確認が別途必要。jsdomのテスト成功を実端末確認済みと解釈しない。
