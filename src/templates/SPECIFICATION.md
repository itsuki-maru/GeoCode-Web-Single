# Teraテンプレート仕様

## 1. 役割

バックエンドが初期データを埋め込んで返すHTMLを管理する。VueのHTML入口はこのディレクトリにはない。地図の操作ロジックは [template-scripts](../../src_frontend/template-scripts/SPECIFICATION.md)、全体の配布経路は [フロントエンド全体仕様](../../src_frontend/SPECIFICATION.md) を参照。

このディレクトリは11個のHTMLを直下に持つ。各ファイル内にページ用DOM・CSS・初期データ定義があり、共通の親テンプレートを中心に組み立てる構成ではない。

## 2. URLとテンプレートの対応

| テンプレート | URL・用途 | ハンドラー |
| --- | --- | --- |
| `map.html` | GET `/map`、PC編集地図 | [map.rs](../handler/map.rs) |
| `map-mobile.html` | GET `/map`、モバイル編集地図 | 同上 |
| `map-anather.html` | GET `/map-another`、別画面・印刷 | 同上 |
| `temporary-map.html` | `/onetime/{url_id}`、PC一時共有 | [onetime_url.rs](../handler/onetime_url.rs) |
| `temporary-map-mobile.html` | 同URL、モバイル一時共有 | 同上 |
| `temporary-password.html` | 同URL、共有パスワード入力 | 同上 |
| `live-map.html` | GET `/live/{public_id}`、位置共有表示 | [live_map.rs](../handler/live_map.rs) |
| `live-map-password.html` | 同URL、位置共有パスワード入力 | 同上 |
| `marker-form.html` | GET `/forms/{public_id}` または `/shape-forms/{public_id}` | [marker_forms.rs](../handler/marker_forms.rs) |
| `image-preview.html` | GET `/images/html/{image_name}` | [assets.rs](../handler/assets.rs) |
| `notfound.html` | 共有・フォーム等を表示できない場合 | onetime_url / live_map / marker_forms |

URL表記は **map-another**、ファイル・entry表記は **map-anather**。現行の名称を維持して参照する。

編集地図と別画面地図はアクセストークンを必要とする。公開URLは通常ログインとは別に、期限・失効・パスワードなどを各ハンドラーで検証する。実ルートとmiddlewareは [router.rs](../router.rs) を正とする。

`map` と一時共有はUser-Agentに `Mobile` が含まれるかでPC／モバイルを選択する。live-mapは単一HTMLを使う。`notfound.html` は全未定義URLに自動適用されるものではなく、Rustの一般フォールバックは `/index` へのリダイレクトである。

## 3. Teraへ渡すデータ

住所検索のある地図では `geocoderCsis` を真偽値で渡し、`meta[name="geocoder-csis"]` に出力する。CSIS設定時のみ共通検索コントロールがLeafletの出典欄へ利用表記を追加する。接続先URL・APIキーは渡さない。

以下はハンドラーが設定する変数名。TypeScript側のプロパティ名と異なる箇所はHTMLで変換する。

| 画面 | Tera変数 |
| --- | --- |
| 編集地図 | `layer`、`is_master`、`markerId`、`latitude`、`longitude`、`zoom`、`tileServers`、`tileVisibilityAccountId`、`tileOverlays`、`layersFromAxum`、`markersFromAxum`、`shapesFromAxum` |
| 別画面 | `is_cluster`、`latitude`、`longitude`、`zoom`、`tileServers`、`tileVisibilityAccountId`、`tileOverlays`、`layersFromAxum`、`markersFromAxum`、`shapesFromAxum` |
| 一時共有 | `layers`、`markersObj`、`shapesObj`、`tileServers`、`tileOverlays`、`isOverlayTile`、`isChecked`、`latitude`、`longitude`、`zoom`、`isMapUiHidden` |
| 一時共有パスワード | `viewport_content`、`error_message`、`url_id`、`isChecked`、`mapStateQuery` |
| 位置共有 | `publicId`、`isCheckOverlay`、`tileServers`、`tileOverlays`、`publishedLayers` |
| 位置共有パスワード | `publicId`、`isCheckOverlay`、`errorMessage` |
| 公開入力フォーム | `form_title`、`form_description`、`form_schema`、`submission_path`、`is_password_protected` |
| 画像プレビュー | `url`（`/static/images/{image_name}`） |
| 見つからない画面 | `viewport_content`、`statuscode`、`message` |

地図は `window.__GEOCODE_MAP_BOOTSTRAP__`、位置共有は `window.__GEOCODE_LIVE_MAP_BOOTSTRAP__`、フォームは `window.__GEOCODE_MARKER_FORM__` を生成する。通常・別画面の図形は配列、一時共有はオブジェクトという違いがある。

編集HTMLはbootstrapから `layer`、`is_master`、`markerId`、座標、`tileServers`、`layersFromAxum` 等の変数も作る。編集entryはこの共有スコープに依存するため、bootstrapだけ残して変数展開を削除しない。

### JSONの埋め込み

[lib.rs](../lib.rs) が `json_encode_for_html` フィルターを登録する。HTMLのscript内にJSONを安全に置くためのエスケープを行い、テンプレートでは `json_encode_for_html | safe` を使用する。`safe` 単独で任意の入力を安全にするものではない。

新しい項目はRustのcontext、Tera変数、bootstrapの型・検証、利用するスクリプトの全箇所を合わせて変更する。

## 4. DOMとスクリプト・資材

| HTML | module entry |
| --- | --- |
| map / map-mobile | `/assets/template-map.js` / `template-map-mobile.js` |
| map-anather | `/assets/template-map-anather.js` |
| temporary-map / temporary-map-mobile | `/assets/template-temporary-map.js` / `template-temporary-map-mobile.js` |
| live-map | `/assets/template-live-map.js` |
| marker-form | `/assets/template-marker-form.js` |
| image-preview | `/assets/template-image-preview.js` |

パスワード画面は通常のHTMLフォームを使用する。フォーム送信先は一時共有が `/onetime/{url_id}`、位置共有が `/live/{publicId}/authenticate`。画面状態のクエリを引き継ぐ。マーカー・図形の公開フォームは同じmarker-form HTMLを使用し、渡されたsubmission_pathへスクリプトがPOSTする。

地図HTMLはmoduleより前にLeaflet、MarkerCluster、marked、xss等を読み込む。関連CSSにはleaflet、MarkerCluster、github、map-controlsがあり、通常・一時共有等はmap-compatも参照する。共通資材は主にPCプロジェクトのpublicとvendorコピー処理から供給される。

地図の `map`、位置共有の `vehicle-list`・`error`、公開フォームの `marker-form` などのDOM IDはスクリプトの接続点。DOM ID・class・data属性を変更する場合は対応するentryとDOM取得処理を確認する。CSSはHTML内、PC public、template-scriptsの印刷CSS等に分散している。

印刷は `map-anather.html` を使い、entryが `print=1` で印刷初期化へ分岐する。Vueとの通信は [スクリプト仕様](../../src_frontend/template-scripts/SPECIFICATION.md) を参照。

## 5. ビルドとサーバー読み込み

1. 統合スクリプトが直下の `*.html` を `dist/templates/` へコピーする。
2. Rustの `Templates` がそのディレクトリをrust-embedで参照する。
3. `build_tera_from_embed` がHTMLだけをTeraに登録する。
4. ハンドラーがcontextを渡し、HTMLレスポンスを生成する。

ソースHTMLの変更だけでは既存の配布バイナリは更新されない。フロントエンド成果物を統合後、Rustのリリースビルドを更新する。`SPECIFICATION.md` はHTMLコピー・Tera登録の対象外。

## 6. 検証と変更時の注意

- HTMLに記載した固定module URLとViteのentry名を一致させる。
- 共通vendor・CSSが `/assets/` に配置されることを確認する。
- 初期データの変数名、配列／オブジェクトの形、条件分岐をRustと照合する。
- DOMの変更は通常・モバイル・共有・印刷それぞれへの影響を確認する。
- 公開URLのアクセス制御をHTMLだけの条件分岐で代替しない。

地図の参照・entry接続テストはPCディレクトリで `npm run test:template-js`、初期データやフォームの単体テストはtemplate-scriptsディレクトリで `npm test`。共有期限・パスワード・認可・Teraレンダリングを含む動作はバックエンドと組み合わせて確認する。
