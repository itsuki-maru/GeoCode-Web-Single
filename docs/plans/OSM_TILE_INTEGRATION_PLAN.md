# OSMタイル生成機能の本体移植計画

作成日：2026-11-12。状態：P0〜P6実装済み。P7の自動・統合検証とWindows配布物作成済み。実機導入など残る受入項目と結果は[移植実装記録](OSM_TILE_PORT_PROGRESS.md)に記載する。

管理情報の保存先と本体migration 26は、後続の[タイル管理DBの分離計画](LOCAL_TILE_CATALOG_DB_SPLIT_PLAN.md)で見直す。本書には移植当初の設計を残し、分離の実装・移設条件は後続計画に従う。

専用管理UI・管理HTTP API・CLIの方針は、さらに後続の[CLI化とフロントエンド共通化計画](LOCAL_TILE_CLI_AND_FRONTEND_COMPAT_PLAN.md)で変更する。今後はPostgreSQL版と共通のフロントを使い、SQLite限定の管理操作は本体CLIへ移す。

全ソースのビルド識別を描画世代へ使う当初の方針は、[描画世代識別の修正計画](LOCAL_TILE_RENDER_IDENTITY_PLAN.md)で変更する。現在は診断用のビルド来歴と取り込み・描画の互換性を分離する。

OSM-Tile-GeneratorのソースをGeoCode-Web-Singleの内部モジュールへ移植し、PBF取り込み、完成DBの管理、PNG生成・保存、ローカルHTTP配信、管理画面を本体の機能として提供する。独立したSDKへのpath依存や別のタイルサーバーを必要とせず、本体側で仕様・保守・配布を管理する。

タイル関連ファイルは既定で`~/.geocode-web-single/tiles/`配下へ置く。完成DB・PNG・取り込み作業領域の保存先を、既存画像の保存先と同じ`geocode-web-single.env.json`の設定経路で個別に変更できるようにする。

## 1. 実装範囲と前提

### 今回の対象

- ローカルPBFからの完成DB作成。取消・進捗・失敗状態の表示を含む。
- 既存の互換完成DBの登録。検証用大DBを再取り込み・複製せず参照できるようにする。
- 完成DBからのオンデマンド生成、PNGの永続保存、ローカル配信。
- bboxとズーム範囲を指定した事前生成、枚数確認、中断後の再開。
- 管理画面でのデータセット・ジョブ・背景地図登録の管理。
- 通常地図、モバイル、共有、回答地図、ライブ地図、印刷でのローカル背景利用。
- 元PBF不在・ネットワーク遮断下での地図表示の受入。

### 維持する描画仕様

XYZ、Web Mercator、256×256px、不透明PNG、固定`roads-v1`、z0〜22を維持する。z0〜5は背景のみ。建物・水域・海岸線・ラベル・ルーティング・住所検索の追加は本計画に含めない。候補のない有効タイルは正常な背景画像として扱う。

完成DBのschema/geometry version 1と既存PNGの互換性を最初の移植で維持する。`feature_bounds`は正規化Web Mercatorであり、PBFの取得範囲を保証しない。表示範囲や事前生成範囲の指定に、緯度経度bboxと混同して使用しない。

### 対応環境

本体の現在の正式サポートであるWindows 64bitを必須受入とする。Linuxでは既存のビルド経路に加え、移植したプラットフォーム非依存部分の検証を行える構成を保つが、本計画によって本体全体のLinux正式サポートを追加したとは扱わない。

移植元は`OSM-Tile-Generator`のcommit `5d96058296f891af32f23690d02cbae6de11c533`を基準とする。実装開始時に差分を再確認し、採用版と変更一覧を記録する。引き継ぎ書の絶対パスと「L04未コミット」は作成時点の記録として扱う。

## 2. 現行実装と接続方針

| 現行の仕組み | 移植時の扱い |
| --- | --- |
| `src/init.rs`の初回JSON作成・旧JSON補完 | タイル用設定を追加し、既存値を保持して補完する |
| `ApplicationInitSetup` → `apply_env_vars` → `CONFIG` | 保存先・実行上限も同じ経路へ接続する |
| `GET /tile/{z}/{x}/{y}.png` | 外部プロキシとして維持する |
| 外部プロキシのRedis・revision・`?v=` | ローカル生成と混在させず、既存契約を維持する |
| 背景地図の同一オリジン絶対パス対応 | ローカル用URLを通常のラスタ背景として登録する |
| 管理設定のアプリDB保存 | データセット・ジョブ等の運用情報を追加する |
| 初回セットアップ直後・通常Tauri・`-s` | 共通の生成runtime初期化・終了処理を使う |

外部タイルを利用する既存の設定・背景定義を自動で置き換えない。ローカル背景を追加し、利用者が選択できるようにする。ローカル生成の失敗時に外部タイルへ自動接続する処理は設けない。

## 3. 本体内の構成

提案する配置は次のとおり。実装時の小さなファイル分割は変更可能だが、依存方向を維持する。

```text
src/tilegen/
  mod.rs
  geometry.rs / simplify.rs / style.rs / tile.rs
  store.rs / renderer.rs / dataset.rs
  cancel.rs / operation.rs / metrics.rs
  pbf.rs / import.rs
  batch.rs / output.rs
  paths.rs / cache.rs / runtime.rs / jobs.rs
src/handler/local_tiles.rs
src/db/local_tiles.rs
src/model/local_tiles.rs
src_frontend/frontend-admin/src/views/LocalTiles.vue
tests/tilegen_*.rs
tests/fixtures/tilegen/
```

`sdk.rs`の`Dataset`・worker専用`RenderSession`・型付きerrorは、`dataset.rs`等の内部APIとして活用する。移植時は描画アルゴリズムを維持し、パス参照・依存API・呼び出し境界を中心に調整する。

取り込み・検索・描画の核はHTTPや管理画面へ依存させない。`runtime`が有限の要求受付、重複抑制、worker、終了を管理し、`cache`が識別・検索・公開を管理する。HTTPハンドラーは認証・入力検査・応答への変換を担当する。

CLI用`main.rs`・`cli.rs`、CLI起動用の`clap`・`ctrlc`は移植しない。取消・終了・ログは本体へ接続する。`batch`・`output`は事前生成用に取り込むが、独立した無制限の描画系を作らず、オンデマンド生成と実行枠・保存先・排他を共有する。

現行batchはPNG・manifest・progress DBを同じrootで管理し、manifestなしの既存PNGを拒否する。本体では、PNGを共有キャッシュへ、manifest・進捗を`_jobs/<job-id>`へ分離し、オンデマンド生成済みPNGも再利用できる保存経路へ改修する。batch全体の出力lockが通常のタイル配信を停止させないよう、ジョブ所有とkey単位公開の排他を分ける。

## 4. 保存先とJSON設定

### 保存先の3項目

| JSON項目 | 既定の保存先 | 主な内容 | 内部環境変数 |
| --- | --- | --- | --- |
| `tile_dataset_path` | `~/.geocode-web-single/tiles/datasets` | 完成DB、完成直前DB、データセット付属情報 | `TILE_DATASET_PATH` |
| `tile_cache_path` | `~/.geocode-web-single/tiles/png` | 生成PNG、公開用一時PNG、事前生成の進捗・manifest・lock | `TILE_CACHE_PATH` |
| `tile_work_path` | `~/.geocode-web-single/tiles/work` | 取り込みのstaging DB・journal、ジョブ固有の作業ファイル | `TILE_WORK_PATH` |

設定JSON自体は引き続き`~/.geocode-web-single/geocode-web-single.env.json`に置く。3項目は独立した保存先とし、PNGだけ別ディスクへ配置できる。既存の`image_file_path`・`upload_file_path`はタイル保存に流用しない。

たとえばWindowsでDBとPNGを別ドライブへ置く設定は次のようになる。既存JSONの他の項目を保持して追記・変更する。

```json
{
  "tile_dataset_path": "D:/GeoCode/tiles/datasets",
  "tile_cache_path": "E:/GeoCode/tiles/png",
  "tile_work_path": "D:/GeoCode/tiles/work"
}
```

既定配置のイメージは次のとおり。実際のディレクトリ名はOSで使用可能な不透明IDとし、表示名をファイル名に使わない。

```text
~/.geocode-web-single/
  geocode-web-single.env.json
  geocode-web.sqlite
  images/
  tiles/
    datasets/<managed-id>/data.sqlite
    png/<dataset-id>/<render-id>/<z>/<x>/<y>.png
    png/<dataset-id>/<render-id>/_jobs/<job-id>/...
    work/<job-id>/staging.sqlite
```

### 値の解決と移行

- 既定値は`dirs::home_dir()`から組み立てた絶対パスをJSONへ保存する。表記上の`~`をそのまま永続化しない。
- 新しいタイル保存先には絶対パスを要求する。空文字列、相対パス、未展開の`~`は設定エラーとして場所と修正方法を示す。既存画像設定の解釈は変更しない。
- `ApplicationInitSetup`、移行用Partial、`EnvDefaults`、`complete_env`、欠落検査、`apply_env_vars`、`CONFIG`をまとめて更新する。
- 旧JSONの欠落項目または`null`は既定値で補完する。既存のカスタム画像・DB・タイル設定値は保持し、既存の`.bak`作成方式を利用する。再読込で再移行を繰り返さない。
- 初回セットアップ画面への保存先入力は追加せず、JSON編集による変更とする。管理画面には有効な保存先を管理者向けに表示する。
- JSONが実行時設定の正本であり、`.env`への追記は要求しない。変更後の再起動で反映する。全起動経路で同じ値を使う。
- 起動CWDに依存させない。タイル用のパス検証を`CONFIG`の遅延初期化任せにせず、待受開始前に行い、GUI・`-s`ともに理解できるエラーを返す。

### 作成・移設・障害時の動作

保存先は必要な機能の開始前に`create_dir_all`で作成し、権限と公開方法を確認する。ローカルデータセット未登録時は、設定JSONの補完だけで既存アプリを利用できるようにする。ローカル生成を有効にする段階で必要な書き込み先が使えなければ、有効化・ジョブ開始を拒否する。

既存完成DBは読み取り専用のまま使用できる。取り込みをしない利用では、完成DB側の書き込み権限を要求しない。PNGと作業領域には別途書き込み先が必要となる。

この3項目が管理するのは、アプリが明示的に作成するDB・journal・PNG・ジョブ作業ファイルである。SQLiteが検索・ソート中に内部作成する一時ファイルはOS標準の一時領域を利用し、その空き容量・権限も受入で確認する。SQLiteの一時保存先指定はプロセス共通で、稼働中の別接続にも影響するため、`TEMP`や`PRAGMA temp_store_directory`を書き換えない。内部一時ファイルまでタイル専用ディスクへ限定する専用VFSは、本計画の初期実装範囲に含めない。[SQLiteの一時保存先仕様](https://www.sqlite.org/c3ref/temp_directory.html)

保存先変更による既存ファイルの自動移動・削除は行わない。停止後に必要なディレクトリ内容を移し、JSONを更新して起動する手順を用意する。管理対象DBはrootからの相対位置で登録し、root変更後も同じ構造で移設できるようにする。外部参照として登録した完成DBの絶対パスは別途変更する。

PNG保存先だけを空の場所へ変更した場合は、新しい場所へ必要なPNGを再生成する。旧PNGは元の場所に残す。存在しないドライブや書き込み失敗時に、既定のCドライブ等へ黙って保存先を戻さない。DBの移し忘れは利用不可として表示し、同名の空DBを作らない。

### 別ディスクでも安全に公開する条件

- PNGの完成直前ファイルは最終PNGと同じディレクトリへ作る。共通の`tile_work_path`からのrenameを前提にしない。
- importの`staging.sqlite`は`tile_work_path`へ置けるが、完成直前の`data.building.sqlite`は完成DBと同じディレクトリに置く。
- 現行importはhard linkで上書きなしの原子的公開を行う。移植時に対象ファイルシステムの対応を確認し、未対応の場合は書き込み開始前に明示する。同等の上書き防止・完成前不可視を満たす公開方法を実装できた場合だけ対応範囲を広げる。
- SQLite journal・一時DB・完成直前DBは、ライフサイクルごとに所有ジョブを記録する。DB配置先にも完成直前DBとjournal分の空き容量が必要になる。
- 異常終了後の残骸は、実行中ジョブでないことと所有範囲を確認して扱う。清掃対象はジョブ固有領域とし、設定されたroot全体を削除しない。

## 5. 依存とビルドの整合

本体SQLx 0.8.6の`libsqlite3-sys`は0.30.1、移植元rusqlite 0.41.1側は0.39.1であり、そのままでは同じSQLiteネイティブライブラリの依存が競合する。

最初に、本体SQLxを維持し、移植側を`rusqlite 0.32.1`の`bundled`・`hooks`へ合わせる案を検証する。ローカルmanifestでは同じ`libsqlite3-sys 0.30.1`を使える。`progress_handler`の戻り値が異なるため、`store`・`import`のhook登録処理を調整する。取消・deadline・hook解除後の再利用、完成DB読取、PNG比較を通して採否を確定する。成立しない場合は、理由と影響を整理して依存方針を見直す。

`tiny-skia`、`libm`、PBF読取関連等の追加依存とfeatureは、本体のCargo.tomlとCargo.lockへ集約する。既存のCLI用feature名を機械的に残さず、取り込み・PNG生成・事前生成を標準機能として提供する。公開版にPythonや別生成実行ファイルを追加しない。

本体の`build.rs`では`tauri_build::build()`を維持し、生成機能のbuild識別を追加する。移植ソース、Cargo.toml/Cargo.lock、対象arch、rustc、関連featureと描画結果に影響する設定を識別へ含める。アプリの配布版と描画識別を区別して記録し、実際の依存解決を含む保存namespaceを作る。保存先、worker数、queue上限、期限は描画識別に含めず、PNGのディスク移設だけで世代が変わらないようにする。`CARGO_PKG_VERSION`が本体の版になることを踏まえ、DB形式版、importer実装版、描画版を分ける。

本体の検証toolchainを記録し、移植元のMSRV 1.90をそのまま本体全依存の保証とはしない。移植先のビルド・回帰が通る条件を本体側で固定する。

## 6. データセットとジョブの管理

アプリDBに、データセット登録、描画世代台帳、ジョブ履歴を追加する。テーブル名案は`local_tile_datasets`・`local_tile_render_profiles`・`local_tile_jobs`。既存の`tile_server_settings`にはローカルファイルパスや生成ジョブを混在させない。

データセットには登録ID、SDK由来のdataset識別、表示名、管理対象の相対DB位置または外部参照パス、形式版、出典・データ日時、登録・検査状態を記録する。新規importは専用ディレクトリへ作成し、完成検査と登録が成功してから地図で選択可能にする。既存DB登録はコピーせず検査・参照できるようにする。

描画世代台帳には`render_id`と完全cache識別、保存namespace、作成build、画像仕様、保持・退役状態の対応を永続化する。更新前の世代も、台帳で確認できる範囲の保存済みPNGを配信する。未知のディレクトリをURLから推測して配信しない。

ジョブには種別、対象データセット・描画識別、入力と範囲、状態、開始終了、上限、再開情報、所有プロセス・作業領域、失敗分類を記録する。状態は少なくとも待機・実行中・取消要求・成功・失敗・取消・期限終了・中断を区別する。操作monitorの成功はPNG生成までであり、アプリ側の保存・公開成功を別に判定する。

進捗はmonitorから取得し、管理画面で定期取得する。DB更新・通知頻度を制限し、全進捗イベントを永続化しない。起動時は所有者とプロセスlockを確認し、実行元不在と判定できた孤立ジョブだけを中断へ遷移させる。別プロセスの稼働中ジョブを起動処理だけで書き換えない。取り込みは途中再開せず新しい作業領域で再実行し、事前生成だけをmanifest・出力検査に基づいて再開する。

PBF取り込みは最初は同時1ジョブとする。入力PBFは管理者がサーバー上の絶対パスで指定し、自動取得・自動複製・自動削除を行わない。通常Tauriでも同じ管理画面を利用できる。別端末のブラウザから巨大PBFをアップロードする機能や専用ネイティブファイル選択UIは初期対象に含めない。

完成DBは不変とし、更新時は別DBを作る。使用中DBの上書きやsidecarの機械的削除を行わない。切替・利用停止では受付・実行中ジョブ・sessionを管理し、旧結果が新しいデータセットのnamespaceへ公開されないようにする。

## 7. 配信URLと永続キャッシュ

### ローカル用URL

新設する公開route案は次のとおり。

```text
GET /local-tiles/{dataset_id}/{render_id}/{z}/{x}/{y}.png
```

`dataset_id`・`render_id`は、サーバーが登録・算出した安全なIDとして検証する。任意のファイルパスを要求パラメーターにしない。`TileId::new`相当の検査でz0〜22を受け付け、既存外部プロキシのz0〜19検査は維持する。背景設定UI等に共通のズーム制限があれば、ローカル背景の範囲を扱えるよう関連箇所を調整する。

URLへデータセット・描画世代を含め、ブラウザの長期キャッシュも分離する。現在の描画識別に一致する正常応答には`image/png`と版付きURL用のCache-Controlを付ける。失敗応答は`no-store`とし、既存の`X-Tile-Cache`のHIT/MISS表示も利用する。

旧URLは別のDB・描画世代へ読み替えない。旧世代の保存済みPNGは保持中なら配信可能とし、旧描画版でのmissは現在の描画で埋めず410とする。同じ描画版で旧DBを保持している場合は、当該DBからの生成を許容できる。明示的に退役・削除されたデータセットのURLも410とする。未登録ID・不正XYZは404とする。

### 保存と競合

永続キャッシュの識別は、本体build・依存・描画設定の識別と、移植した生成核のcache keyの組とする。ディレクトリ表現の`dataset_id/render_id/z/x/y`から完全な識別へ一意に対応させる。外部プロキシ用Redis・旧XYZだけのキャッシュとは共用しない。ローカル機能はRedisなしで動作する。

処理順は次のとおり。

1. 要求ID・XYZ・配信可能な世代を確定し、完成PNGを検索する。
2. missなら完全なcache keyの実行中jobへ合流するか、有限queueへ新規登録する。
3. 生成権取得後にcacheを再確認する。
4. worker専用sessionでPNGを生成する。
5. 完成PNGを保存先内の一時ファイルへ書き、取消・期限・配信可能世代を再確認する。
6. 上書き競合を扱って原子的に公開し、公開済み成功を確定して応答する。

失敗・取消・期限終了を正常PNGとして保存しない。破損キャッシュは正常hitにせず、診断を残して安全に再生成する。公開済み成功を、遅れて届いた取消で失敗へ戻さない。

初期版は同じ保存先に対する生成runtimeを単一ownerとし、OSのプロセス間lockで保護する。プロセス内mapだけで完了としない。重複起動でownerを取得できないプロセスは、新規描画・import・事前生成・清掃を開始せず、管理画面へ理由を示す。登録台帳に対応する完成PNGの読み取り配信は可能とし、missは503とする。通常の外部タイル機能は継続できる。

共有するPNG保存先・作業領域・管理対象DBへのwriterが別プロセスから入り込まないよう、lock対象を定める。外部参照の読み取り専用DBへlockファイルを作ることは要求しない。複数writerによる生成は、実行枠・ジョブ所有も含むプロセス間制御を追加する後続拡張とする。

初期版ではPNGの自動期限削除・自動LRU削除を行わない。管理画面で容量・世代ごとの使用量と明示的なキャッシュ削除を提供し、実行中・参照中の世代を保護する。容量不足時は保存失敗を返し、別ディスクへの無断退避や失敗PNGの保存をしない。完成DB・元PBFの削除はキャッシュ清掃に含めない。

## 8. 実行上限と終了処理

以下は最初の実測に使う暫定値であり、HTTP性能保証ではない。保存先と同様にJSONから読み、正の整数・許容範囲を検証する。

| JSON項目 | 暫定既定値 | 意味 |
| --- | --- | --- |
| `local_tile_workers` | `"2"` | オンデマンドと事前生成を合わせた実描画数 |
| `local_tile_queue_capacity` | `"128"` | 待機する固有タイルjob数 |
| `local_tile_max_subscribers` | `"256"` | 完了未受取を含む待機要求の上限 |
| `local_tile_background_queue_capacity` | `"4"` | 取り込み・事前生成を合わせた待機ジョブ数 |
| `local_tile_job_timeout_seconds` | `"120"` | queue待機を含む共有生成jobの期限 |
| `local_tile_http_timeout_seconds` | `"60"` | 個々のHTTP購読者の待機期限 |
| `local_tile_precompute_max_tiles` | `"1000000"` | 事前生成1ジョブの受付枚数上限 |

PBF取り込み同時数は初期版では1、事前生成の実行ジョブ数も1とし、単一ownerが実行数・待機数を一括管理する。待機上限を超える管理jobは503で拒否する。タイル用の120秒をPBF全体の取り込み期限へ適用せず、取り込みは明示取消と終了処理で停止できるようにする。事前生成対象は順次投入し、全タイルをqueueやメモリへ一括展開しない。対話表示を優先し、事前生成が描画枠を占有し続けないスケジューリングを設ける。`batch`内部の独立Rayon poolで実描画上限を迂回させない。

描画は専用worker上で行い、sessionはworkerが所有・再利用する。異なるDBへ切り替える場合も、workerごとのsession保持数を制限する。contextはjobごとに新規作成し、sessionと一緒に再利用しない。生成時間、queue待ち、PNG encode、公開、HTTP待ち、RSS・出力量を分けて記録する。

HTTP期限と共有job期限を分離する。一人の切断で他の購読者の生成を止めず、最後の購読者が離脱し、事前生成等の所有者もいない場合に取消する。HTTP futureやjoin handleの破棄をworker終了とは扱わず、実処理が終わるまで枠を保持する。

終了は全起動経路で、受付停止→待機job取消→実行中job取消→worker実終了の回収→所有一時ファイルとジョブ状態の整理、の順に行う。OSのI/Oやcodec内は協調取消ですぐ止まらない場合があるため、期限を厳密な処理終了時刻とは表示しない。

## 9. 管理画面とAPI

既存の外部「タイルサーバ設定」とは別に「ローカル地図」を追加する。管理操作は既存の管理者認証・認可とCSRF対策の経路を利用する。ファイルパス・作業状態・診断詳細は管理者向けに限定する。

提供する操作は、保存先・容量・稼働状態の確認、PBF取り込み、完成DB登録、プレビュー、出典・データ日時の確認、背景地図登録、事前生成枚数確認・開始・取消・再開、ジョブ履歴、キャッシュ整理とする。DB登録直後に既存背景を変更せず、「背景地図に追加」の明示操作で登録する。

API案を以下に示す。実装時の型・既存命名との整合で調整する。

| API案 | 用途 |
| --- | --- |
| `GET /admin/local-tiles/status` | 保存先、実行枠、容量、利用可否 |
| `GET /admin/local-tiles/datasets` | 登録済みDBと状態 |
| `POST /admin/local-tiles/datasets/register` | 既存完成DBの検査・外部参照登録 |
| `POST /admin/local-tiles/imports` | PBF取り込みjob作成 |
| `POST /admin/local-tiles/datasets/{id}/background` | ローカル背景の登録 |
| `POST /admin/local-tiles/precompute/plan` | bbox・zoom検査、枚数確認 |
| `POST /admin/local-tiles/precompute` | 事前生成・同一条件での再開 |
| `GET /admin/local-tiles/jobs` | ページ分割したジョブ履歴一覧 |
| `GET /admin/local-tiles/jobs/{id}` | 進捗と終端状態 |
| `POST /admin/local-tiles/jobs/{id}/cancel` | 取消要求 |
| `POST /admin/local-tiles/datasets/{id}/retire` | 参照影響を示した利用停止 |
| `POST /admin/local-tiles/cache/cleanup` | 指定世代のPNG整理 |

長い取り込み・事前生成はジョブIDを返す非同期操作とし、HTTP接続を保持し続けない。再送で同じimportが重複開始しないよう、既存のidempotency方式または同等の受付識別を使う。

入力不正・未登録は既存の検証error/404、上限到達・一時的利用不可は503、HTTP待機期限は504、退役済み世代は410を基本案とする。生成errorの分類と原因chainをログへ残す。DB不正・変更検出・I/O・描画・encodeを区別し、内部パスや原因chainを公開タイル応答へ出さない。SDKの`InvalidOperation`相当は呼び出し側の不備として修正する。

## 10. 地図UIとオフライン動作

ローカル背景は同一オリジンのラスタ定義として共通処理へ渡す。移植元の出典情報を既存の安全化処理へ接続し、通常・モバイル・共有・印刷/PDFへ表示する。出典リンクを表示するために自動通信しない。

共有スナップショットが保存するのは背景URL等であり、PNG自体ではない。共有が参照するDB・描画世代を保持する必要がある。利用停止やキャッシュ削除の画面で、登録背景・保存済み共有への影響を示す。旧世代URLの410とキャッシュ保持方針を利用手順に記載する。

Leaflet等の既存ローカル資材を利用する。外部manifest参照が残る`frontend/index.html`・`temporary-map*.html`等を確認し、通常地図・共有表示の必須資材をローカルにそろえる。Service Workerが旧世代PNGや失敗応答を固定しないことも確認する。

受入で保証するオフライン範囲は、ローカル背景による地図表示・本体保存データの閲覧・共有表示・印刷とする。外部住所検索、外部背景、気象タイル、外部カメラ等は個別の外部機能として扱い、地図表示成功のために要求しない。ローカル背景選択中に、描画経路から外部fallbackを行わないことを通信記録で確かめる。

## 11. 実装段階と完了条件

| 段階 | 成果物 | 完了条件 |
| --- | --- | --- |
| P0 移植基準と依存検証 | 採用版、依存方針、テスト対応表 | SQLite依存の一本化案とtoolchainが成立し、移植対象・不要CLIが確定 |
| P1 生成核の移植 | `src/tilegen/`、build識別、移植回帰 | 本体内から完成DB読取・単一PNG生成・取消が動き、代表PNGが移植元と一致 |
| P2 設定と保存先 | JSON補完、paths、ジョブ用DB移行 | 旧JSON保持、別ドライブ、全起動経路、読み取り専用DBの条件を満たす |
| P3 runtimeと配信 | worker、排他、永続PNG、専用route | miss→保存→hit、並行miss抑制、期限・切替・終了の統合試験が通る |
| P4 DB登録と地図接続 | 既存DB登録、管理画面、背景・出典 | 既存DBを複製せず登録し、PC・モバイル・共有・印刷で利用できる |
| P5 PBF取り込み | import job、進捗・取消・完成登録 | 小PBFで成功/失敗/取消/再起動を検証し、完成前DBを配信しない |
| P6 事前生成と運用 | dry-run、事前生成・再開、記録と共有PNGの分離、容量表示・整理 | 同じ実行上限・排他・namespaceを使い、既存cache hitと再開で完成PNGを再利用できる |
| P7 総合受入と配布整備 | 遮断・実データ検証記録、利用文書 | 単体実行ファイルで受入条件を満たし、既存外部タイル機能も回帰しない |

P1とP2はP0後に一部並行可能。P3は両方を使用する。P4で既存完成DBによる一連の利用を先に成立させてからP5へ進む。P6はP3の実行・公開契約に合わせる。各段階は変更をレビューできる単位で区切り、計画作成のみで完了扱いにしない。

### 主な変更対象

- `Cargo.toml`・`Cargo.lock`・`build.rs`・`src/lib.rs`。
- `src/init.rs`・`src/model/common.rs`・`src/config.rs`・`src/main.rs`。
- `src/router.rs`、追加のhandler/model/db、`src/db/pool.rs`の移行登録、新規migration。
- 管理画面のrouter・ナビゲーション・新規画面、背景登録との連携。
- 共通地図の背景・出典・ズーム検査、共有・印刷、必要なローカルmanifest。
- Rust回帰・管理UI回帰・共通地図回帰、移植fixture。
- README、SPECIFICATION、TILE_PROXY、MAP_VIEWING、管理機能、配布時依存表記、新規のローカル地図利用文書。

## 12. 検証計画

### 自動回帰

移植元のSDK・import/store・PBF・geometry/renderer・取消/期限・outputのテストとfixtureを、本体の対象へ移す。`tests/support`と`include_str!`先も引き継ぐ。CLI実行を前提とする試験は、本体API・ジョブの同等試験へ置き換える。独立SDKの外部consumer試験は、本体内部APIとHTTP統合へ置き換える。

| 分類 | 必須の確認 |
| --- | --- |
| 設定 | 初回作成、旧JSON・nullの補完、既存値保持、再読込不変、不正値、再起動反映、3起動経路 |
| 保存先 | 空白・日本語・別ドライブ、CWD変更、読み取り専用完成DB、消失ドライブ、容量不足、公開方式非対応、OS一時領域の権限・容量 |
| 生成・公開 | 不正XYZ、z境界、正常背景、失敗未保存、原子的公開、途中ファイル不可視、破損PNG |
| 並行性 | 同一keyの1生成、異なるkeyの上限、queue/購読者/管理job待機上限、単一ownerのプロセス間lock |
| 取消・期限 | 一人離脱、全員離脱、queue期限、実描画期限、実worker終了までの枠保持、次の正常要求 |
| 世代・寿命 | DB変更検出、切替中job、旧URL、旧描画版miss、session退役、共有参照中の停止・清掃 |
| import | 小PBF、欠損Node方針、入力変更、取消、公開競合、容量不足、中断後、既存DB非上書き |
| 事前生成 | bbox・zoom・枚数上限、stream投入、取消、同一条件再開、異なる条件の再開拒否、表示要求との枠共有 |
| 終了・再起動 | Tauri終了、`-s` Ctrl+C、job回収、途中公開防止、残骸識別、孤立jobだけの中断復元、稼働中の別プロセスjobの保持 |
| 本体互換 | 外部プロキシ、Redis optional、revision/CSP、背景設定、共有スナップショット、出典・印刷 |

既存回帰には`tile_proxy`、`tile_server_settings_routes`、`tile_configuration`、背景地図・共有、管理UIの`TileServerSettings`・`BackgroundMaps`、`tile-proxy-url`・`tile-attribution`・印刷系を含める。

### 実データと実アプリ受入

1. 合成小PBFで取り込みから背景登録・表示までを確認する。
2. 保存済み宮城県DBを明示パスで登録し、`14/14603/6304`を1枚生成して移植元PNGと比較する。SDKで記録された94,789 bytesを参考値とし、同じDB・条件での実際のバイト一致を確認する。
3. 必要な小範囲へ広げ、cold/warm、miss/hit、並行要求、事前生成との同時実行を測る。HTTP、queue、SDK相当の生成、公開、RSS・出力量を分ける。
4. 元PBFを参照できない状態、読み取り専用の完成DB、Redisなし、ネットワーク遮断で配布相当アプリを起動する。PC・モバイル表示、共有、印刷を確認し、必須資材とローカルタイルだけで継続利用できることを確認する。
5. PNG保存先だけを別ドライブへ変更して再起動し、保存・再利用・ドライブ障害時の表示を確認する。DB・作業領域との3ディスク構成も確認する。
6. 移植元ディレクトリを含めない隔離したビルド用ソース一式から成果物を作り、SDK path依存・元開発パス・別生成実行ファイルが配布条件になっていないことを確認する。

実データ試験は1系列600秒以内を初期上限とし、打切り条件を決める。保存済み大DBを不要にコピー・再import・起動時全SHA計算しない。過去CLIの性能値をHTTPのSLOへ転用しない。

### 文書と配布の確認

既存CIに合わせてフロントエンドの型検査・関連テスト・ビルド、埋込成果物生成、Rust整形・関連回帰と全体回帰を実施する。追加依存の配布表記を更新し、単体exe・インストーラで既定保存先と既存設定補完を確認する。

`cargo --offline`の成功と、実アプリのネットワーク遮断受入を別々に記録する。検証記録には対象commit、toolchain、依存版、DB識別、設定値、保存先のファイルシステム、通信条件、測定範囲を残す。

## 13. 完成の判定と運用手順

以下をすべて満たして移植完了とする。

- 本体がPBF取り込み・完成DB登録・オンデマンド生成・事前生成・配信を所有する。
- SDKリポジトリやCLI実行ファイルを配置しなくても本体をビルド・配布・起動できる。
- タイル関連の既定保存先がホーム配下にまとまり、JSONでDB・PNG・作業領域を独立変更できる。
- 旧JSON・既存画像設定・外部タイル利用との互換性が保たれる。
- 保存・排他・実行上限・取消・世代切替・終了が統合試験で確認される。
- 小地域の実データと、元PBF不在・ネットワーク遮断の実アプリ受入が完了する。
- 操作、保存先移設、バックアップ、世代保持、共有への影響、取消・再開、容量不足時の手順が文書化される。

バックアップはアプリDB・設定JSON・保持したい完成DBを基本とする。PNGは同じDB・描画版から再生成可能だが、旧描画版の共有表示を保つ場合はその世代のPNGも保持する。PBFは再取り込みが必要な場合に別途保管する。

利用を戻す場合は新しいローカルjobの受付を止め、実worker終了を待ち、背景を既存の外部背景等へ切り替える。完成DBや元PBFを自動削除しない。旧アプリ実行ファイルへの戻しは、追加migrationと設定項目の後方互換を確認した範囲に限定する。

## 参照

- [タイル生成SDKの引き継ぎ](../../OSM-Tile-Generator/GIS_SERVER_HANDOFF.md)
- [既存タイル配信](../TILE_PROXY.md)
- [全体仕様](../../SPECIFICATION.md)
- [設定JSONの初期化と移行](../../src/init.rs)
- [実行時設定](../../src/config.rs)
- [起動と終了](../../src/main.rs)
- [背景地図登録](../../src/handler/background_maps.rs)
- [Cargoのネイティブ依存リンク制約](https://doc.rust-lang.org/cargo/reference/build-scripts.html#the-links-manifest-key)
