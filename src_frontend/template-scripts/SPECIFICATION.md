# Tera用スクリプト仕様

## 1. 対象

Tera HTMLから読み込むTypeScript/ES Modulesを管理する。Vueアプリではなく、Leaflet地図、公開入力フォーム、画像プレビューをDOM上で動作させる。

関連: [全体構成・配布](../SPECIFICATION.md)、[TeraのデータとURL](../../src/templates/SPECIFICATION.md)、[PC UI](../frontend/SPECIFICATION.md)、[モバイル UI](../frontend-mobile/SPECIFICATION.md)、[機能詳細](../../SPECIFICATION.md)。

## 2. ディレクトリと責務

```text
template-scripts/
├── src/
│   ├── entries/             ページ入口・編集ソースの順序定義
│   ├── map/
│   │   ├── types.ts         通常・別画面・一時共有の初期データ型
│   │   ├── bootstrap.ts     初期データの読み取り・検証
│   │   ├── read-only-page.ts 閲覧専用ページの組み立て
│   │   ├── common/          地図表示・検索・図形・設定保存など
│   │   ├── editor/          編集画面の処理
│   │   └── print/           印刷プレビュー・CSS
│   ├── live-map/            公開レイヤ、タイル、操作UI
│   ├── marker-form/         フォーム型・初期化・画像縮小
│   └── dom.ts               DOM補助
├── tests/                   Vitestテスト
├── vite.config.ts           entry生成・出力規則
└── dist/                    生成JS・CSS・manifest
```

### 共通地図処理の探し方

| ファイル群（map/common） | 責務 |
| --- | --- |
| `map-runtime`、`base`、`page-controls` | 初期地図、基本操作、コントロール |
| `layer-groups`、`marker-layers`、`overlay-events` | レイヤ構築、表示同期 |
| `marker`、`map-object-focus` | マーカー表示、位置情報、対象への移動 |
| `search` | 検索、対象絞り込み、表示再構築 |
| `shape-*` | 図形スタイル、矢印、復元、メモ、計測、表示範囲 |
| `content*`、`markdown-*` | Markdown・埋め込み、サニタイズ、ファイル操作 |
| `storage`、`map-view-persistence` | 背景・表示設定、中心とズームの保存 |
| `tile-*`、`nowcast-*` | 重ね合わせタイル、出典、雨雲時刻・更新 |
| `map-ui-visibility`、`visibility-controls` | UI・表示切り替え |
| `print-state` | 印刷状態と用紙等の共有定義 |

## 3. エントリーとビルド

| entry | 実装入口 | 公開JS |
| --- | --- | --- |
| `map` | 仮想entry、PC編集ソース | `/assets/template-map.js` |
| `map-mobile` | 仮想entry、モバイル編集ソース | `/assets/template-map-mobile.js` |
| `map-anather` | `entries/map-anather.ts` | `/assets/template-map-anather.js` |
| `temporary-map` | `entries/temporary-map.ts` | `/assets/template-temporary-map.js` |
| `temporary-map-mobile` | `entries/temporary-map-mobile.ts` | `/assets/template-temporary-map-mobile.js` |
| `live-map` | `entries/live-map.ts` | `/assets/template-live-map.js` |
| `marker-form` | `entries/marker-form.ts` | `/assets/template-marker-form.js` |
| `image-preview` | `entries/image-preview.ts` | `/assets/template-image-preview.js` |

Vite出力はES2022、`dist/`、manifestは `template-manifest.json`。entry名は固定、共有chunkは `template-[name]-[hash].js`、資材は `template-[name]-[hash][extname]`。entry以外の生成物も必要なため、配布時はdist全体をコピーする。

### 3.1 編集画面の仮想entry

[vite.config.ts](vite.config.ts) の `editorEntryPlugin` が [editor-entry-sources.ts](src/entries/editor-entry-sources.ts) に定義されたソースを読み、共通preludeとprofileを付加して結合する。各ソースは独立した実行単位ではなく、結合後の共有スコープに依存する。

順序は、mode → PC/mobile base → PCのみshape-filter → shape-state → measurement → metadata → delete → geometry → drawing → controls → final。finalの前にfocus用bridgeを挿入する。順序の変更は参照・初期化タイミングに影響する。

profileは `isMobile` と操作文言を持ち、入力判定や保存後の更新差を切り替える。編集ファイルには `@ts-nocheck` があり、型チェックだけでは結合後の実行を保証できない。閲覧専用・live-mapにも型チェックを抑止する境界がある。

### 3.2 ブラウザ資材

Leafletの `L`、marked、filterXSS等はTera HTMLが先に読み込む。npm管理vendorを配布資材へコピーする処理はPC側 `scripts/copy-vendor-assets.mjs` が担当する。Panzoomはこのプロジェクトの依存。依存の具体的なバージョンは [package.json](package.json) とlockfileを参照。

## 4. 初期データ

| データ | 利用画面 | 主な項目 |
| --- | --- | --- |
| `window.__GEOCODE_MAP_BOOTSTRAP__` | 編集・別画面・一時共有 | page、tileServers、layers、markers、shapes、initialView等 |
| `window.__GEOCODE_LIVE_MAP_BOOTSTRAP__` | 位置共有 | publicId、tileServers、tileOverlays、isCheckOverlay、publishedLayers |
| `window.__GEOCODE_MARKER_FORM__` | マーカー・図形公開フォーム | schema、submissionPath、isPasswordProtected。詳細は [フォームbootstrap](src/marker-form/bootstrap.ts) |
| HTMLのDOM・属性 | 画像プレビュー | Teraで設定された画像URL等 |

[types.ts](src/map/types.ts) では、編集画面の `shapes` と別画面の `shapes` は配列、一時共有はIDをキーにしたオブジェクトである。各画面のpage値、selectedLayer、isMaster、markerId、isCluster、isChecked、isMapUiHiddenなども異なる。

[bootstrap.ts](src/map/bootstrap.ts) はpage・主要コンテナ・初期座標の型等を検証するが、ネストした全レコードの厳密検証ではない。編集HTMLはbootstrapから旧来の変数名へ値を展開し、結合スクリプトが参照する。すべてのentryが同じ検証関数を通ると解釈しない。

Tera変数の正本とJSON埋め込み処理は [テンプレート仕様](../../src/templates/SPECIFICATION.md) を参照。

## 5. ページ別動作

- **編集地図**: マーカー・図形の作成、移動・編集、削除、計測など。fetchによる更新、トークン更新と親画面通知を持つ。
- **別画面・一時共有**: `initializeReadOnlyMapPage` が地図を組み立て、表示・検索・計測を提供する。編集用の保存操作を共有しない。
- **印刷**: `map-anather` のentryが `print=1` を検出すると `initializePrintPreview` に分岐する。
- **位置共有**: `/live-api/maps/{publicId}/positions` を取得して位置表示を更新する。公開レイヤ・タイルと位置情報を扱う専用entryで、通常地図bootstrapとは別構成。
- **公開フォーム**: フォーム定義から入力UIを構築し、画像縮小などを行い、指定されたsubmissionPathへFormDataをPOSTする。マーカー・図形で共有する。
- **画像プレビュー**: Teraが設定した対象を表示し、Panzoom等で操作する。

細かな図形種別、制限値、共有期限、印刷用紙、ナウキャストの仕様は [ルート仕様書](../../SPECIFICATION.md) を参照する。

## 6. Vueと編集地図の通信

実装: PC/mobileの `components/map/MapIframe.vue`、[map-editor-final.ts](src/map/editor/map-editor-final.ts)。

### 6.1 親画面から地図

| type | データ | 応答・用途 |
| --- | --- | --- |
| `focus` | objectType、id、lat、lng | 対象へ移動・表示。応答なし |
| `mapObjectFilter` | markerIds、shapeIds（配列またはnull） | 一覧に対応する絞り込み。応答なし |
| `markerFilter` | ids | 地図側に残るマーカー用受信処理 |
| `mapObjectUpdate` | requestId、payload | `mapObjectUpdateResult` |
| `mapObjectDelete` | requestId、id | `mapObjectDeleteResult`。現在の受信処理はマーカー削除を適用 |
| `tileOverlaysUpdate` | requestId、tiles | `tileOverlaysUpdateResult` |

結果メッセージはrequestIdとsuccessを返す。更新payloadは各Vueの [MapObjectUpdatePayload](../frontend/src/interface.ts) を参照し、マーカー／図形の識別と更新値を渡す。Vue側は2秒で未応答をfalseとし、画面破棄時も待機を解除する。要求送信自体はDB更新ではなく、親で更新したデータを地図表示へ反映するために使用する。

### 6.2 地図から親画面

| type | データ・用途 |
| --- | --- |
| `callParentReload` | layerId（省略・null可）、message。親の一覧・地図更新要求 |
| `callParentLoginRedirect` | message。ログイン画面への遷移要求 |
| `callParentFunction` | messageに画像URL等。PC用画像表示 |
| `callParentImagePreview` | messageに画像URL等。モバイル用画像表示 |
| `userLocationUpdate` | position。現在位置共有への連携 |
| `userLocationError` | code。位置情報取得失敗 |
| `printOpen` | PCの印刷開始 |

親側は許可originとiframeのcontentWindowを確認する。編集地図側は送信元がwindow.parentで、同一originまたは `http://localhost:5173` / `http://localhost:3000` の場合に受け付ける。この許可値はapp-initの動的設定とは異なる。

要求への応答は要求元originに送る。一方、ログイン・再読み込み・画像表示通知には送信先 `"*"` の既存処理がある。すべての送信でoriginを限定していると記述しない。

### 6.3 印刷通信

PCの [PrintMapModal.vue](../frontend/src/components/map/PrintMapModal.vue) が編集地図と印刷iframeを仲介する。

1. 親→編集地図: `printStateRequest`（requestId）。
2. 編集地図→親: `printStateResult`（requestId、state）。中心・ズーム、背景、タイル、マーカー・図形・名前の表示状態。
3. 印刷iframe→親: `printReady`。
4. 親→印刷iframe: `printInitialize`（state）。親が対象layerIdsを追加する。
5. 印刷iframe→親: `printInitialized`、失敗時は `printError`。
6. 親→印刷iframe: `printExecute`。印刷iframeからの終了要求は `printClose`。

親は送信元windowとoriginを区別し、state応答はrequestIdも検証する。読み込みは15秒でエラー表示になり、再試行できる。詳細状態・用紙は [print-state.ts](src/map/common/print-state.ts)、実装は [print-preview.ts](src/map/print/print-preview.ts)。

## 7. 設定保存と表示

| 保存キー | 内容 |
| --- | --- |
| `geocode-web:last-map-view` | 地図の中心・ズーム |
| `geocode-web:selected-tile-server-id` | 背景地図 |
| `geocode-web:map-mobile-ui-hidden` | モバイル地図UIの非表示 |
| `geocode-web:marker-visible` | マーカー表示 |
| `geocode-web:shape-layer-visible` | 図形表示 |
| `geocode-web:shape-name-visible` | 図形名表示 |
| `geocode-web:user-location-visible` | 現在位置表示 |
| `geocode-web:tile-overlay-visibility:{accountId}` | アカウント別の重ね合わせタイル表示 |

localStorageを使う。どのページが保存・復元を利用するかはentryとread-only-pageで切り替える。共有地図に通常編集画面の保存値を一律適用しない。

通常・モバイル・別画面の重ね合わせタイルはアカウント別に復元する。最新の有効なタイルIDにreconcileし、不要な保存値を整理する。一時共有・位置共有はこのアカウント別保存を利用せず、共有設定・URLから初期表示を決める。位置共有の `is_check_overlay` は未指定・false・不正値で初期非表示。

保存領域が利用不能でも表示を継続する処理を持つ。背景などアカウントIDを含まないキーと、タイル用アカウント別キーを区別する。

## 8. テスト・配布

このディレクトリで実行する:

```sh
npm ci
npm run type-check
npm test
npm run build
```

`test` はwatchではなく `vitest run`。`build` は型チェック後にViteを実行する。dev/previewスクリプトはない。distは生成物なので直接編集せず、[統合ビルド](../SPECIFICATION.md) で全ファイルを `/assets/` 用の配置へコピーする。

| 検証場所 | 対象 |
| --- | --- |
| `tests/` | bootstrap、共通地図、図形・検索・保存・タイル・ライブ地図・フォーム等 |
| `tests/editor-entry-contract.spec.ts` | 編集entry構成 |
| `tests/read-only-entry-contract.spec.ts` | 閲覧専用entry構成 |
| `../frontend/tests/template-js/` | Tera参照、entry結合、実vendorとのスモーク、印刷等 |

接続テストはPCディレクトリで `npm run test:template-js` を実行する。型チェック抑止箇所を変更した際は、単体テストだけでなくentryとvendorを組み合わせるテストを確認する。ブラウザAPIや実印刷の実機確認とは区別する。
