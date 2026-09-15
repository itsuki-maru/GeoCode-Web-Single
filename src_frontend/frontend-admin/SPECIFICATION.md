# 管理 UI 仕様

## 1. 概要

ユーザー管理、現在位置共有マップ、重ね合わせタイルを設定する独立したVueアプリ。関連: [全体構成](../SPECIFICATION.md)、[全体の権限・API仕様](../../SPECIFICATION.md)、[公開地図テンプレート](../../src/templates/SPECIFICATION.md)。

## 2. ディレクトリ構成

```text
frontend-admin/
├── index.html / public/       HTML入口・静的資材
├── src/
│   ├── mainAdmin.ts           初期化とマウント
│   ├── AdminApp.vue           ヘッダー・管理メニュー・RouterView
│   ├── style.css / assets/    スタイル
│   ├── router/               画面遷移・API URL
│   ├── views/
│   │   ├── auth/             管理者ログイン
│   │   ├── users/            ユーザー管理
│   │   ├── live/             位置共有マップ管理
│   │   ├── TileOverlays.vue   重ね合わせタイル設定
│   │   └── NotFoundAdmin.vue  Vue内の未定義ルート
│   ├── components/common/    モーダル・通知・確認
│   ├── stores/               appInits、auth、users
│   ├── axiosClient.ts        Cookie付き通信・認証更新
│   ├── interface.ts          型定義
│   ├── setting.ts            環境変数
│   └── test/                 テスト共通設定
└── dist/                     個別ビルド成果物（生成物）
```

実際の画面登録は [router/index.ts](src/router/index.ts) を正とする。`AdminAppTop.vue` は存在するが、現在のrouterからトップ画面として登録されていない。

## 3. 起動・認証・画面遷移

[mainAdmin.ts](src/mainAdmin.ts) はPiniaとRouterを登録し、app-init取得処理のfinallyでマウントする。`AdminApp.vue` はログイン画面以外で管理メニューを表示する。

| Vue内パス | 遷移先・画面 |
| --- | --- |
| `/`、`/admin` | `/users/list` へリダイレクト |
| `/users/list` | `AdminUsersList.vue` |
| `/account/login` | `LoginViewAdmin.vue` |
| `/live-maps` | `AdminLiveMaps.vue` |
| `/tile-overlays` | `TileOverlays.vue` |
| その他 | `NotFoundAdmin.vue` |

保護画面のルートガードは `/account/auth` を呼ぶ。これは認証確認であり、Vueルーター自体で管理者権限を保証しない。管理APIの権限確認はRustが行う。

配信入口 `/admin` はCookie認証を必要とし、Rustが管理者なら管理HTML、非管理者ならPC HTMLを選ぶ。管理アプリのログイン画面はVue内の画面であり、未認証の `/admin` が必ずこのHTMLを返す仕様ではない。管理画面の内部URLを直接再読み込みした場合も [全体のURL仕様](../SPECIFICATION.md) に従う。

ログインは `/account/token` にユーザー名とパスワードを送る。二重送信を抑止し、成功時はユーザー一覧、失敗時はパスワード欄を空にして通知する。PC・モバイルと同じTOTP入力UIを持つとは限らないため、認証変更時は [LoginViewAdmin.vue](src/views/auth/LoginViewAdmin.vue) を個別に確認する。

## 4. 管理機能

### 4.1 ユーザー管理

[AdminUsersList.vue](src/views/users/AdminUsersList.vue) がユーザー一覧、作成、パスワード更新、ロック解除、位置共有権限を扱う。

| 操作 | API |
| --- | --- |
| 一覧 | GET `/admin/users` |
| 作成 | POST `/admin/user/create` |
| パスワード更新 | POST `/admin/user/password-reset/{id}` |
| ロック解除 | POST `/admin/user/unlock/{id}` |
| 位置共有権限変更 | PUT `/admin/users/{id}/live-location-permission` |

一覧にはID、ユーザー名、作成日、権限、状態、位置共有の情報を表示する。フォームの入力制約とAPI側の検証は別に存在する。

### 4.2 位置共有マップ

[AdminLiveMaps.vue](src/views/live/AdminLiveMaps.vue) はマップ名、有効期限、共有対象、表示名・色、共有パスワード、公開する管理者レイヤを扱う。UI上の対象上限は20件。取得・保存・URL再発行・失効と、それぞれの進捗・エラー表示を持つ。

| 操作 | API |
| --- | --- |
| アカウントの共有状況 | GET `/admin/live-locations` |
| マップ取得・作成 | GET / POST `/admin/live-maps` |
| 更新・失効 | PUT / DELETE `/admin/live-maps/{id}` |
| URL再発行 | POST `/admin/live-maps/{id}/rotate-url` |
| 公開レイヤ候補 | GET `/admin/live-map-layers` |

`use_tile_overlays` はマップ側の利用可否として保存する。一方「重ね合わせタイルを初期表示する」は生成URLの `is_check_overlay` を変更するUI状態で、DBに保存しない。タイル利用不可のマップでは生成URLもfalseになる。

公開レイヤ候補を取得し、選択を編集中の状態に反映する。別の管理者が設定したレイヤの扱いは `layers_configured_by_other` などの応答とルート仕様書を参照する。公開後の閲覧・位置更新は `live-map.html` とtemplate-scriptsの責務。

### 4.3 タイル追加設定

[TileOverlays.vue](src/views/TileOverlays.vue) が `/admin/tile-overlays` にGET・POST、`/{id}` にPUT・DELETEする。URLはrouterの定数ではなく画面内で組み立てる。

登録項目は表示名、URL、出典、最小・最大ズーム、不透明度、並び順、有効状態。新規初期値はズーム0〜18、不透明度0.7、並び順0、有効。保存結果を一覧へ反映し、並び順と名前で整列する。

ユーザーへの表示・選択、HTTPS URL等の検証、出典HTMLの扱いは [全体機能仕様](../../SPECIFICATION.md) を参照。無効化と削除は異なり、削除すると各アカウントの登録も解除される。画面は再読み込みによる地図への反映を案内する。

## 5. 状態とエラー処理

- `stores/appInits.ts`: アプリ名などの初期設定。
- `stores/auth.ts`: UIの認証状態。PC版の再認証・トークン切り替えフラグは持たない。
- `stores/users.ts`: ユーザー一覧など。
- 位置共有マップ・タイルの編集状態と処理中フラグは各Vue画面のref等で管理する。

[axiosClient.ts](src/axiosClient.ts) はCookie付き通信を行い、token期限切れでrefreshして元の要求を再試行する。refresh失敗時はログアウト状態とログイン遷移を処理する。画面側は処理中の入力・送信抑止、通知や再試行を実装する。

権限・パスワード検証の正本はバックエンド。API項目や返却形式の変更では、画面内のローカル型、`interface.ts`、Rustハンドラーを照合する。

## 6. 開発・配布・テスト

このディレクトリで実行する:

```sh
npm ci
npm run dev
npm run type-check
npm run test:run
npm run build
```

Viteの環境変数はルートのものを使用する。個別出力の `dist/index.html` は統合時に `index-admin.html` に改名する。詳細は [統合ビルド](../SPECIFICATION.md) を参照。

テストは `src/**/__tests__/` にあり、router、Axios、ストア、ログイン、ユーザー管理、位置共有マップ、タイル設定を対象とする。管理者／非管理者のサーバー認可は、Vueのモックテストだけで検証済みとはしない。
