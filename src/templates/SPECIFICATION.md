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

## 回答地図の追加絞り込み

- PostgreSQL版先行。回答地図専用の `form-answer-map.html` / `form-answer-map.ts` を使用し、通常の `map-anather` と印刷の経路を維持する。SQLite版は変更しない。
- PC・モバイルのAnswerMapModalは同一構成。共通フォームと最大10件のAND条件で初期対象を絞る。日付・数値の範囲は両端を含む。0・false・未入力・項目なしを区別する。値はsubmitted_values、定義はform_snapshotを使用する。
- 初期map APIから取得したquery/as_ofと対象IDをmap-filter JSON APIに渡す。候補は追加条件で狭めず、0件でも編集・解除できる。候補・件数・検索は読み取りトランザクション内で取得する。
- answer-filter.tsはorigin・親window・requestId・更新IDを確認し、初期対象の部分集合だけを受け付ける。対象IDは種別を含む。保持済みレイヤを再利用し、iframeを再読み込みしない。中心・ズーム・名前検索・レイヤ選択を保持する。
- 共通検索のisRecordAllowedは任意の判定関数。未指定の通常地図は従来動作。回答地図では検索解除・レイヤ切替でも追加条件を維持する。表示件数は実際に表示中のレイヤを数え、表示不可の対象と区別する。
- 失敗時は直前の地図を維持し、古い応答・閉じた画面の応答を破棄する。解除は元の一覧条件へ戻す。範囲変更は「表示対象に合わせる」で明示的に行う。閉じるボタンは左下。一覧状態・通常地図設定は保存変更しない。
- answer-preview.tsは初期の範囲調整・件数・query/targetsのready通知を担当する。失敗はform-answer-map-error.htmlで通知する。HTMLのJSON値はjson_encode_for_html経由とし、成功・失敗ともno-store。
- 色分けUI・凡例は追加絞り込みへ置き換える。answer-analysis.tsと任意analysis入力は旧呼び出しの互換性維持に限って残す。
## 回答地図の印刷（PostgreSQL版・PC先行）

- 回答地図の「地図を印刷」またはCtrl+P / Command+Pから既存の印刷プレビューを開く。モバイル版は印刷UIを表示しない。用紙・タイトル・印刷・PDF出力・画像読み込み待機は共通処理を使用する。
- 印刷開始時点で、反映済みの回答条件・名前検索・レイヤ表示・マーカー/図形表示をすべて満たす対象を固定する。画面外の対象も保持し、用紙上の範囲はプレビューで調整できる。未反映の条件編集は使用しない。更新中・0表示対象では起動しない。
- 元の地図から中心・ズーム・背景地図・重ね合わせタイル・図形名の表示設定と、対象の保持済みデータを複製する。本文・メモは検索のために再解析しない。DBの再検索・対象の追加取得は行わず、全選択や名前検索解除でも除外対象を復活させない。
- 対象は最大10,000件、転送データはUTF-8 JSONで32MiBまで。超過時は切り捨てず条件を絞るよう案内する。送信元origin/window・地図要求ID・条件更新ID・印刷要求IDを照合する。印刷スナップショットは印刷中に変更しない。
- 認証必須POST /form-answers/map-printはform-answer-map-print.htmlの枠だけを返す。parent_origin・request_idを検証し、Cache-Controlはno-store。対象データは親からpostMessageで受け取る。初回表示・再試行の401はauthenticated-form.tsによる認証更新と1回の再送に対応する。
- 専用entry form-answer-map-print.tsで検証したスナップショットを初期化し、print-preview.tsの共通処理へ渡す。通常の/map-another?print=1の初期化は従来どおり。印刷キーは最前面の回答地図・印刷プレビューへ接続する。
- 閉じた後は元の回答地図の条件・中心・ズーム・レイヤ状態を維持する。通常地図の保存設定、DBスキーマ、SQLite版は変更しない。
