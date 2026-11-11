# 背景ベクタタイルの試作（計画①）

以下は計画①時点の独立試作の記録です。計画③の本体画面への接続と検証方法は末尾に記載しています。

Leaflet 1.9.4 に MapLibre GL JS 6.17.0 と
`@maplibre/maplibre-gl-leaflet` 0.1.4 を接続する独立した検証ページです。
通常画面への接続、DB変更、共有形式v2の実装はまだ行いません。

## 実行

リポジトリ直下で、通常のtemplate-scripts依存が導入済みであることを確認します。
追加依存はこのディレクトリだけに導入します。

```powershell
npm --prefix src_frontend/template-scripts/prototypes/vector-basemap ci --ignore-scripts
npm --prefix src_frontend/template-scripts/prototypes/vector-basemap run type-check
npm --prefix src_frontend/template-scripts/prototypes/vector-basemap run check
```

`check` は既存のChromeを使い、ビルド・ローカル配信・ブラウザー検証・PDF保存を実行して終了します。
デスクトップ幅とモバイル幅のChrome、WebGL無効、旧共有スナップショット再表示を確認します。
localhostへの通信とブラウザープロセスの実行が必要です。

手動確認は `npm run build` の後に、このディレクトリで `npm run serve` を実行し、
`http://127.0.0.1:4187/` を開きます。
`/?legacy-share=1` は保存済みv1共有の印刷経路を使います。
サーバーは127.0.0.1だけで待ち受けます。

## 構成と互換性

- `main.ts` は既存 `createPrintPreview`、`createReadOnlySnapshotPrintPreview` と実際のPDF出力UIを使います。
- `global-leaflet.ts` とビルド時のaliasで、bridgeと既存コードが同じ `window.L` を参照します。
- `maplibre-basemap.ts` は描画完了・失敗・破棄をLeafletのイベントと印刷状態へ接続します。
- ラスタは従来の `L.tileLayer` を使用します。ベクタ切替完了まで直前の背景を保持し、失敗・競合時に破棄します。
- ベクタは試作ページの一時状態に限定し、v1共有・印刷snapshotやlocalStorageへ保存しません。
- DB、共有URLのルーティング／認可／保存処理、通常の背景設定・重ね合わせ処理、本体のpackage/lockは変更していません。
- 本体への共通変更は、明示的な `data-geocode-maplibre-canvas` を持つcanvasの印刷・PDF画像化です。通常の画像タイルには適用されません。

## 配信データとCSP

`fixtures.mjs` が自作のMVT、4文字（東京・公園）のSDF glyph PBF、sprite PNG/JSON、ラスタPNGを生成します。
実在の地理情報を再現するデータではありません。外部の地図・フォント素材は使用しません。
`localIdeographFontFamily: false` により文字PBFの取得も検証します。

`serve.mjs` は本体のproduction CSPを読み、`worker-src 'self'` だけを明示追加します。
タイル・文字・アイコン・Workerは同一オリジン配信で、外部通信を追加許可しません。
ネットワーク記録で全資材の取得成功を確認し、正例のCSP違反が0件であることを検証します。

## 印刷・PDF

試作では `preserveDrawingBuffer: true` を使用し、描画済みWebGL canvasをPNGへ変換します。
ブラウザー印刷の間はcanvasを保持したまま画像を表示し、終了・失敗・破棄時に復元します。
準備中の操作と二重開始は抑止します。PDFではhtml2canvasの複製DOM内の対象canvasだけを画像へ置換します。
PDFの出力形式は従来どおり画像です。

## 検証結果

ChromeのWebGL 2.0（ANGLE / NVIDIA GeForce RTX 3060 / D3D11）で以下を確認しました。

- デスクトップ1440×1000、モバイル幅430×932でMVT・日本語ラベル・spriteを描画。
- 既存Leafletマーカー・図形との重ね合わせ、出典表示。
- A3縦からA4横への用紙変更後の再描画、既存PDF出力ボタンからの保存。
- 印刷ボタンが画像化後にwindow.printを呼び、その後canvasを復元すること。
- Chromiumの印刷スタイル適用によるPDF生成。
- 404による切替失敗で直前背景を保持し、連続切替で古い結果を採用しないこと。
- WebGL無効時にラスタを保持し、未処理の例外を残さないこと。
- 保存済みv1共有の印刷経路で、保存された表示位置がlocalStorageの設定より優先されること。
- 旧v1共有・印刷snapshotの検証成功、snapshotとlocalStorageの内容を維持。

変更後の関連回帰テストはtemplate-scriptsの9ファイル131件、frontend印刷テスト23件が成功しています。
本体の型チェック・ビルドと試作の型チェックも成功しています。

成果物はリポジトリ直下の `target/vector-basemap-poc/evidence/` に保存します。
`results.json` はブラウザーの判定・GPU情報・通信記録です。
`desktop-vector-export.pdf` / `mobile-vector-export.pdf` は既存PDF出力、
`*-vector-browser-print.pdf` はブラウザー印刷によるPDFです。
PDFはPopplerでPNGへレンダリングし、背景・文字・アイコン・マーカー・出典を目視確認します。

## 試作で判明した点と次工程

bridge 0.1.4はWebGL初期化失敗後の `onRemove` で存在しないGL mapを参照します。
試作のadapterで、未生成時はcontainerだけを削除する対処を入れ、WebGL無効試験を通しています。
上流資材を直接書き換える処理はありません。

背景表示と既存の印刷・PDFへの接続は成立しました。次工程では、背景定義の追加、全画面への共通controller接続、
共有v1/v2対応、承認した外部配信元のCORS/CSPと版管理を実装します。
MapLibreは通常ラスタ画面へ遅延読み込みし、ラスタ利用時の転送量増加を避ける設計が必要です。

実機iOS/Android/Safari、物理プリンター、長時間のGPU負荷、外部配信元は未検証です。
PostgreSQLの隔離実行環境がないため、Rustの共有URL実DBテストも未実行です。
既存アプリDBには接続していません。

## 本体の共通描画（計画③）

`src/map/common/basemap-controller.ts` と `basemap-layer.ts` を通常・モバイル・共有・回答・ライブ地図へ接続しました。
ラスタは従来のLeaflet画像タイルを同期生成し、URL・表示ズーム・部分表示・出典HTMLを維持します。
ベクタはMapLibre本体・CSS・同一originのWorkerを遅延読み込みし、初回描画が完了した候補だけを確定します。
候補の失敗・中止時は確定済み背景を保持し、連続選択の古い結果を破棄します。
切替中にチェック済みの元背景を再クリックした場合も中止でき、共有・印刷は切替完了後の確定IDを使います。
表示中の背景に障害が起きても読み込み中の最新候補を優先し、代替ラスタの自動表示では保存済みの好みを更新しません。

保存済み共有v1は種類なしのラスタ定義をそのまま読み、v2は共有時に保存されたスタイル定義を使用します。
既存共有JSONの一括変換や、既存ラスタをベクタへ変更する処理はありません。
外部配信元の設定はリポジトリのREADMEの `VECTOR_TILE_ALLOWED_ORIGINS` を参照してください。

本体の依存と、このディレクトリのPlaywright依存を導入してから、リポジトリ直下で実行します。

```powershell
npm --prefix src_frontend/template-scripts run build
node src_frontend/template-scripts/prototypes/vector-basemap/verify-pages.mjs
```

WebGL初期化に失敗する環境の検証は、同じコマンドの前に `$env:VECTOR_WEBGL_DISABLED='1'` を設定します。
通常地図での切替失敗とv2共有の初期復元を検証し、ラスタ維持・候補の破棄・未処理例外なしを確認します。
この結果は `results-webgl-disabled.json` へ分けて記録します。通常検証へ戻す際は環境変数を解除してください。

`pages-fixture.mjs` は本体の7種類のHTMLテンプレートとビルド済みJSを使用し、APIと地図配信だけをローカルの自作データへ置き換えます。
既存アプリやアプリDBは起動しません。デスクトップ／モバイル幅のChromeで、MVT・日本語ラベル・sprite・出典、
失敗時の背景維持、応答を保留した実ラジオの連続操作、保存済みv1/v2共有を検証します。
閲覧地図ではLeafletマーカーを表示し、本体印刷iframeと既存PDF出力での重なりも確認します。
ベクタ確定時もLeafletのズーム制約登録を維持し、重ね合わせの制約と合成します。
最後のラスタを外してもズーム上限が無限大にならず、既存MarkerClusterの再生成が停止しないことを回帰テストに含めます。
本体production相当のCSPを付け、未処理例外・CSP違反・外部通信がないことと、Workerが同一originであることを確認します。

成果物は `target/vector-basemap-pages/evidence/` の `results.json`、画面PNG、`production-map-anather-vector.pdf` です。
PDFはPopplerでPNGへレンダリングし、背景・文字・アイコン・既存マーカー・出典を目視確認します。
Rust側の背景取得と保存済み共有URLは別途 `scripts/postgres-transfer-tests/run.py` で隔離PostgreSQLを使用して検証します。
実機iOS/Android/Safari、物理プリンター、外部配信元、長時間のGPU負荷は引き続き未検証です。

## 本体の受入検証・配布（計画⑤）

④で追加した背景地図設定UIは、既存ID・nullズーム・出典原文と共有v1/v2を維持して登録・編集します。
⑤では本体のビルド済みJSを対象に、次の検証を追加しています。API・地図は自作のローカルデータを使用し、アプリDBへ接続しません。

```powershell
npm --prefix src_frontend/template-scripts run build
node src_frontend/template-scripts/prototypes/vector-basemap/verify-pages.mjs
node src_frontend/template-scripts/prototypes/vector-basemap/verify-lifecycle.mjs
node src_frontend/template-scripts/prototypes/vector-basemap/verify-printing.mjs
```

資源の検証はPC・モバイル幅で各20サイクルを実行します。ラスタ復帰時のレイヤー・canvas数、MapLibreのremoveとWebGL解放、Workerの終了、取消・取得失敗・WebGL喪失時の選択IDを確認します。Workerの累計生成数と生存数を分け、計測用の参照は意図的に保持します。これはヒープ量・GPUメモリ量・実機性能の計測ではありません。結果は `target/vector-basemap-lifecycle/evidence/results.json` です。

印刷は保存済みv1共有のA4横・A3縦、v2共有のA3縦、モバイル幅v2のA4横、回答専用のA3縦の5ケースで、本体の実entryと通信手順を使います。用紙変更後もLeafletとGLのサイズ・中心・ズームが整合し、既存マーカー・日本語ラベル・sprite・出典を保つことを確認します。中心保持はLeafletの整数座標丸めに合わせて投影上1ピクセル以内で判定し、GLとLeafletの同期は別途厳密に確認します。native印刷呼出し直前の画像化とafterprint後の復元を観測し、PDFは本体の出力ボタンから保存します。物理印刷ダイアログは開きません。結果とPDF・画像は `target/vector-basemap-printing/evidence/` です。PDFはPopplerでレンダリングして目視確認します。

A3縦へ変更したベクタ背景では、html2canvasがMapLibre内側の切り取り領域とLeafletの位置補正を誤って合成し、PDFの上部が欠ける問題を修正しました。PDFの複製DOM内だけで画像化した背景の内側の切り取りを解除し、地図全体の切り取りと画面表示・ブラウザー印刷を維持します。回帰検証は背景の四辺を覆うことに加え、jsPDFが実際に取り込む完成canvasの8点を元の背景と比較します。修正前のA3ベクタで欠けを検出し、ラスタA3では検出しないことも確認しています。

印刷画像のdecode中に背景・表示位置・用紙が変わった場合は出力を中止して操作を戻します。無害なMapLibreのload通知はこの変更と区別します。切替で除去した背景のイベント監視を解除し、遅れて届いた通知で印刷待機やPDF無効化を再開しません。終了済みプレビューへ非同期処理からUI更新や印刷再開イベントを送信しません。

配布では、MapLibre本体・Worker内に同梱された依存も `template-third-party-licenses.txt` へ収録し、提供元の本文を見つけられない場合はビルドを停止します。Windowsの統合ビルダーは依存定義の指紋を確認して必要な `npm ci` を実行し、すべてのビルドが成功してから配布先を更新します。失敗時停止と階層を保つコピーは、実スクリプトに検証用npm/cargoを接続して確認します。

```powershell
node --test tests/windows-frontend-build.test.mjs tests/vector-basemap-lifecycle.test.mjs
node --test tests/docker-frontend-build.test.mjs
```

本番反映は、背景列追加のマイグレーション・サーバー・4構成のフロント資材を揃えて行います。スタイル・TileJSON・タイル・glyph・spriteのHTTPS originを `VECTOR_TILE_ALLOWED_ORIGINS` に指定し、配信元のCORSと利用条件を確認します。スタイルは版付きURLを使い、既存共有が参照する版を保持してください。共有が固定するのは背景定義であり、配信元の地図データ自体を保管する機能はありません。

初期状態は既存ラスタのままです。実配信元の背景登録・本番での有効化は⑥で別途行い、切り戻し先は共有v1/v2を読める互換版とします。実機iOS/Android/Safari、物理プリンター、実配信元、長時間のGPU・ヒープ負荷は未検証項目として残します。SQLite・Demo・DBConverterへの移植はこの工程に含めません。

2026-11-11のローカル検証結果（Chrome 157.0.8103.50、PC・モバイル幅）は次のとおりです。

| 検証 | 結果 |
| --- | --- |
| フロントエンド全体 | PC 1,195件、モバイル723件、管理141件、template-scripts 1,251件成功 |
| 画面・共有互換 | 本体7画面、v1/v2の差分を含む11ケース成功 |
| WebGL無効 | 通常地図とv2共有の2ケースでラスタを維持 |
| 資源の破棄 | PC・モバイル幅で各20サイクル成功 |
| 印刷・PDF | 5ケース成功。完成canvas画素とPoppler画像を確認 |
| 配布 | 4構成のDocker COPY入力によるビルド、Windowsビルダー4件、資源検証の判定テスト4件成功 |
| 隔離PostgreSQL | 背景設定・取得・共有・重ね合わせを含む134件成功、診断用ベンチマーク1件は対象外 |

フロントエンドのJSON結果は `target/vector-basemap-acceptance/` に保存します。既存アプリDB・本番環境には接続していません。
