# OSMタイル生成機能の移植実装記録

後続の[CLI化・フロント共通化](LOCAL_TILE_CLI_PROGRESS.md)で専用管理画面と管理HTTP APIを撤去した。現行操作は[ローカル地図](../LOCAL_TILES.md)を参照する。

本書は移植当初の記録である。後続の[タイル管理DB分離](LOCAL_TILE_CATALOG_DB_SPLIT_PROGRESS.md)で、未適用の本体migration 26を削除し、管理情報を専用catalogへ切り替えた。現在の保存構成・検証結果は後続記録を参照する。

対象計画：[OSMタイル生成機能の本体移植計画](OSM_TILE_INTEGRATION_PLAN.md)。開始日：2026-11-12。

この記録では、コードを取り込んだ状態と、受入検証が完了した状態を区別する。

## P0 移植基準と依存

| 項目 | 採用内容 |
| --- | --- |
| 移植元 | `OSM-Tile-Generator` commit `5d96058296f891af32f23690d02cbae6de11c533` |
| 作業開始時の移植元 | Git作業ツリーに変更なし。移植元のファイルは変更しない |
| 本体 | `geocode_web_single` 1.14.0、Rust edition 2024 |
| 実装時toolchain | rustc 1.99.1、cargo 1.99.1、Windows 64bit |
| 本体SQLx | 0.8.6を維持 |
| 移植側SQLite | rusqlite 0.32.1、`bundled`・`hooks` |
| ネイティブSQLite依存 | 本体SQLxとrusqliteが共に`libsqlite3-sys 0.30.1`を利用 |
| 描画 | tiny-skia 0.12.0のPNG対応、libm 0.2.16を固定 |
| 提供機能 | PBF取り込み・PNG生成を本体の標準機能としてコンパイル |
| 追加しないもの | 独立SDKのpath依存、CLIのmain/引数処理、clap、ctrlc |

`cargo check --offline --lib`の依存解決でCargo.lockへ29パッケージを追加した。既存SQLxの更新は行っていない。`cargo tree --locked --offline -i libsqlite3-sys`で両経路が0.30.1へ到達することを確認した。

本体のlib/bin/testコンパイルと生成回帰が成功し、rusqlite 0.32.1による整合案を採用した。最初のcheck実行時点には並行実装中モジュールの欠落があったが、統合後の試験では解消している。

## P1 生成核の移植内容

`src/tilegen/`へ以下を移植した。

- geometry、simplify、style、tile。
- store、renderer、dataset（元のsdk）。
- cancel、operation、metrics。
- pbf、import。

モジュール参照を`crate::tilegen::...`へ変更し、元の`import`・`png`等のfeature分岐を本体の標準機能に合わせて整理した。元のCLIは起動せず、同期APIを本体から呼び出す。

rusqliteの版調整により、`progress_handler`が`Result`ではなく`()`を返す差異を修正した。操作中だけ登録するSQL VM hookと、RAIIによるhook解除の構造は維持した。描画アルゴリズム、道路スタイル、完成DBのschema/geometry versionは変更していない。

`build.rs`はTauriの既存処理を維持し、`TILEGEN_BUILD_ID`を生成する。Rustソース、Cargo.toml/Cargo.lock、build.rs、target、compiler、ビルドfeature等を含める。実行時の保存先、worker数、queue上限、期限は含めない。

### 公開する内部API

| API | 用途 |
| --- | --- |
| `tilegen::dataset::Dataset::open` | 完成DBの検査と共有可能なデータセット作成 |
| `Dataset::info`・`Dataset::profile` | 出典・形式・描画識別 |
| `Dataset::cache_key` | データセットと描画条件・XYZを含む識別 |
| `Dataset::create_session` | worker所有の読取接続作成 |
| `RenderSession::render_png_with_context` | 検索・描画・PNG encodeの一操作 |
| `tilegen::operation::OperationContext` | 操作ごとの取消・期限・進捗 |
| `tilegen::import::run_with_context` | PBFから完成DBまでの取り込み |
| `tilegen::tile::TilePlan`・`GeoBbox` | bbox・ズーム検査、枚数、順次タイル列挙 |

### 移植した回帰試験

| 試験 | 件数 | 主な対象 |
| --- | --- | --- |
| `src/tilegen/`内のunit test | 63 | geometry、描画、DB、取消、期限、取り込み公開 |
| `tests/tilegen_core_sdk.rs` | 12＋任意実データ1 | session再利用、DB識別、PNG、操作context、宮城県比較 |
| `tests/tilegen_core_import_store.rs` | 11 | PBF取り込み、LOD、欠損参照、完成DB |
| `tests/tilegen_core_pbf_reader.rs` | 15 | PBF形式・制限・header・不正入力 |

fixture encoderは`tests/tilegen_support/mod.rs`、実道路の継ぎ目fixtureは`tests/fixtures/tilegen/`へ配置した。通常の移植回帰101件が成功した。実データ試験は既定でignoreし、DB・比較PNGを明示した場合だけ実行する。

比較用PNGは、保存済み宮城県DBを元ツールの既存release実行ファイルへ渡して作成した。入力DBの複製・再取り込みは行っていない。出力先は`target/tilegen-validation/miyagi-reference-20261112.png`、94,789 bytes、SHA256は`e0f60cf13fd8f520b4ffe4af0d641401440dec9f06b7325d4904ffa92ac121f2`。

移植後の`regional_completed_database_matches_reference_png`を明示実行し、`14/14603/6304`のPNGがバイト単位で一致した。移植後出力は`target/tilegen-validation/miyagi-migrated-20261112.png`。当該Windows debug実行では生成2.090秒、encode 53msだった。この単一試行は性能SLOではない。

## P3 runtimeの検証

`tests/local_tile_runtime.rs`の13件がWindowsで成功した。

- 同一keyの並行missを1生成へ合流し、一人の離脱だけでは中止しない。
- 固有jobのqueue上限と、同一keyを含む購読者上限。
- 最後の購読者離脱後も実worker終了まで枠を保持し、次の要求で復旧する。
- job期限切れ後の未公開と、新しいcontextでの正常生成。
- プロセス間owner lockの排他と終了後の解放。
- 破損・過大PNGの読み取りがファイルを変更せず、入力サイズも制限する。
- cache hitではDBを開かず、生成件数が増えない。
- ownerによる破損cache修復、利用停止世代の公開拒否。
- 同じdataset IDでも別handleのDB変更検査を省略しない。
- 待機する事前生成より対話表示を優先する。
- shutdown後の受付拒否と、遅い公開の防止。
- 日本語・空白を含む260文字超の保存先でPNGを公開・再利用する。

PNG・完成DB保存先には原子的公開の能力を要求する。staging用work保存先にはhard linkを要求しない。WindowsのPNG公開は、既存の親ディレクトリをcanonicalizeして得た拡張長パスから一時・最終パスを構築する。

worker sessionは同じ`Arc<DatasetHandle>`に対してだけ再利用し、公開前にもデータセット識別を再検査する。取消は499、生成/HTTP期限終了は504、DB利用不可は503に分ける。公開済み成功は遅れて届いた取消で書き換えない。

## 移植元を含めない本体ビルドの確認

新しいフロントエンドをroot `dist`へ集約した後、本体のCargo.toml/Cargo.lock、build.rs、Rustソース、migration、SQLx query cache、セットアップHTML、配布用dist、アイコン等だけを次の作業場所へ複製した。

```text
target/tilegen-validation/isolated-source-8e128fcd0b70432c8f0a11a6558ceeaf
```

複製は370ファイル、7,812,114 bytes。SDKリポジトリ、`.env`、実DB、PBF、node_modulesは含めていない。元ディレクトリの移動・削除も行っていない。

隔離した本体manifestで`SQLX_OFFLINE=true`として`cargo check --locked --offline`を実行し、lib/binが成功した。依存cacheとtargetの再利用を行い、所要時間は58.89秒。この確認はSDKソースへのpath依存がないことの検証であり、実アプリのネットワーク遮断受入・インストーラ受入とは区別する。

## 検証結果

| 検証 | 状態 |
| --- | --- |
| 移植元commit・作業ツリー確認 | 確認済み |
| offline依存解決 | 成功 |
| ネイティブSQLite依存の一本化 | dependency treeで確認済み |
| 移植ファイルのrustfmt | 実施済み |
| 本体lib/bin/testコンパイル | 対象回帰のビルドで成功 |
| 移植unit・統合回帰 | unit 63件、SDK 12件、import 11件、PBF 15件成功 |
| runtime回帰 | 13件成功 |
| import/事前生成ジョブ | 4件成功 |
| ローカルタイルHTTP統合 | 1件成功 |
| 宮城県完成DBの読取・旧版PNG比較 | 任意実データ試験1件成功。94,789 bytesが一致 |
| SDK除外の隔離本体check | lib/bin成功。SDK・.env・実DBを複製していない |
| P2以降の配信・管理UI・実アプリ受入 | 各段階で記録 |

## P2 設定と台帳

`tile_dataset_path`・`tile_cache_path`・`tile_work_path`を、既存の画像設定と同じJSON作成・補完・環境反映へ追加した。既定はホーム配下`tiles/datasets`・`tiles/png`・`tiles/work`。初回設定直後、通常Tauri、`-s`で同じ設定を使う。実行上限7項目も文字列値で設定できる。

新規タイル保存先は絶対パスを要求し、3用途の同一・包含関係を拒否する。相対パス・未展開の`~`は拒否し、既存画像パスの解釈は変更しない。旧JSONの欠落・nullを補完し、既存カスタム値を保持する。保存先変更による自動移動は行わない。

migration 26でデータセット、描画世代、ジョブ履歴を追加した。取り込みで作るDBは設定rootからの相対位置、外部完成DBは絶対参照として登録する。同じ内容の外部DBを新しいパスで再登録すると参照先を更新する。データセット・描画識別は保存先変更だけでは変わらない。

設定・catalogの回帰5件、既存を含むDB移行19件が成功した。日本語・空白・Windows長パス、旧JSON不変性、path escape、owner別の孤立ジョブ復旧、既存データと追加台帳の再移行保持を確認した。

## P4 地図と管理画面

管理者用の「ローカル地図」を追加した。完成DBの登録、PBF取り込み、単一タイルのプレビュー、背景追加、枚数確認、事前生成・再開・取消、利用停止、指定世代のキャッシュ清掃、PNG容量の明示集計を提供する。

`GET /local-tiles/<dataset>/<render>/{z}/{x}/{y}.png`を新設し、既存外部プロキシは維持した。ローカル背景は共通ラスタ定義へ登録し、出典を引き継ぐ。管理UIの直リンク・再読み込み用に`GET /local-tiles`も本体の管理画面配信へ接続した。

背景または保存済みスナップショットが参照するデータセットの退役・清掃を拒否する。汎用背景登録・編集でも、同じDB書込トランザクション内でローカル世代の利用可否を検査する。旧描画世代の完成PNGは台帳で確認して配信し、旧世代missを現在の描画で埋めない。

最新の管理画面全回帰は16ファイル・171件成功。PC1197件、モバイル723件、共通テンプレート1263件も成功した。全フロントの型検査・ビルドを通し、`frontends-builder.ps1 -SkipCargoBuild`でroot `dist`へ集約した。既存CIが使用する同オプションを正式実装し、削除・移動先のworkspace内検査も加えた。

## P5 PBF取り込み

管理画面からサーバー上のローカルPBF絶対パスを指定し、本体内の同期importをblocking workerで動かす。取り込みは同時1、待機ジョブは事前生成と合わせて有限とした。入力PBFの自動取得・複製・削除は行わない。

進捗、診断、取消、失敗、完成後登録をジョブ台帳へ接続した。HTTP再送は`request_id`で重複抑制し、同じIDで異なる条件を指定した場合は409とする。取り込み成功後の元PBF不在でも同じ受付結果を返す。完了後の遅い取消で成功を取り消さない。

終了と新規jobの受付は同じ追跡lockで同期し、workerの実終了を回収する。取り込みの途中再開は行わず、中断記録から新規実行する。

## P6 事前生成と運用

元のCLI向け`batch`・`output`をそのまま取り込まず、移植した`TilePlan`と共通runtimeを使う本体の事前生成jobを実装した。描画枠・cache key・重複抑制・公開を表示要求と共有し、独立Rayon poolを増設しない。PNGは共有cacheへ、manifestは世代内`_jobs/<job-id>`へ分離した。

bbox・ズーム・枚数上限を検査し、タイルを順次投入する。同じデータセット・描画世代・範囲・ズームの再開記録を検査して完成PNGを再利用する。管理jobの待機枠は実行枠とは別に計上する。PBF→登録→事前生成→元PBF削除後の再開、上限・取消、壊れたPBF、受付ID再送の4回帰が成功した。

PNG容量は明示操作時にだけ走査し、2秒または10万entryで打ち切る。打切り時は確認できた容量を下限として表示する。定期pollで全PNGを走査せず、自動削除・自動LRUは実装しない。

## P7 総合検証

### 全体回帰

`cargo test --locked --offline --lib --bins --tests -- --test-threads=4`で47 suite・486件成功、6件ignoreを確認した。最終レビューの修正後はローカル機能unit 4件と関連統合・DB移行42件を再実行し、すべて成功した。フロントエンドの全回帰はPC1197・モバイル723・共通テンプレート1263・管理171の合計3354件成功した。

最終レビューでは、最後の購読者離脱と新規合流を同じlockで同期し、HTTP future破棄後もblocking初期化が終わるまでshutdownが待つよう修正した。初期化barrierは管理jobの実終了待機前に解放し、admissionとのlock cycleを防ぐ。DB再登録では旧handleの公開権を無効化し、退役後の旧job公開を防止する。読み込み済みDBの消失も一覧全体の失敗にせず、対象行のerrorとして返す。

アプリDBのowner lockは、実ファイルDBではDBの隣、in-memory DBでは設定済みwork配下へ置く。SQLxのin-memory URIをWindowsファイル名として扱わないようにし、URLへ変換する際は安全なダミー名を設定したcloneからmemory modeだけを読む。実接続のファイル名は変えない。in-memoryと日本語名の実ファイルDBの両方を回帰で確認した。初期試験が作った空のlock artifactは所有stream名を確認して削除した。

Windowsサンドボックス内では既存HTTP試験がlocalhost通信制限によりtransport失敗したため、同じコマンドを許可された外側の環境で再実行した。実装変更で既存HTTPの振る舞いを変えて回避していない。起動中の検証用exeとCargoのリンクが競合した初回も、検証サーバー停止後に再実行した。

### 実TCPサーバーとブラウザ

本体の統合routerを実TCPで起動する`tests/local_tile_browser.rs`と、headless Edgeによる`tests/browser/local-tiles-acceptance.cjs`を追加した。テストDB・PBF・保存先は`target/local-tile-browser-*`に隔離し、利用者の実設定JSONやDBは変更していない。通常の自動回帰ではサーバー常駐用試験をignoreする。

管理UIからのPBF取り込み、プレビュー、背景追加、事前生成、PNG容量表示を実操作した。取り込み完了後に元PBFを削除し、ページから外部オリジンへの要求を遮断して、PC地図・モバイル地図・匿名共有地図・ブラウザ印刷用PDFを確認した。外部要求0、page error 0で成功した。

確認時のfixtureでは既定背景をローカル背景へ明示変更した。実際の利用者データの既定背景を変更したわけではない。合成PBFは1本の道路だけなので、広域表示で背景のみとなることと、z14の道路表示を区別して確認した。

成果物は次の場所に保存した。

```text
target/local-tile-browser-31ac63c1-27d0-40c2-9e8f-b8dc50ac9b0f/
  summary.json
  admin-desktop.png
  map-desktop.png
  map-mobile.png
  map-shared.png
  map-print.pdf
```

スクリーンショットは目視確認済み。最初の撮影ではLeafletのfade完了前を捉えていたため、画像opacityの完了を待つ受入スクリプトへ修正して再確認した。

### 受入範囲と残る実機確認

上記は本体routerの統合サーバーと、ブラウザページの外部通信遮断による受入である。OS全体の回線遮断、配布インストーラからの新規導入、実際のTauriウィンドウ終了操作は別の実機確認として残る。

保存先の分離・移設・長パス・読み取り専用DBは自動試験で確認したが、今回はCドライブ上の独立ディレクトリを使用した。Eドライブは未接続のremovableとして検出され、物理的に異なるディスク間の実測は行っていない。公開用ファイルをそれぞれの最終保存先と同じファイルシステムへ作る構成で、cross-volume renameを必要としない。

### Windows配布物

最終修正後に`cargo tauri build --ci -- --locked --offline`が成功し、単体exeとNSIS・MSIを生成した。Tauri CLI 2.1.0と既存のWindowsツールを使用した。サンドボックス内の初回はNSIS資材のDNS取得に失敗したため、許可された外側の環境で再実行した。`--offline`はCargoの依存解決に対する指定で、インストーラ作成ツールの資材取得まで保証するものではない。

| 成果物 | サイズ |
| --- | --- |
| `target/release/geocode_web_single.exe` | 61,052,416 bytes |
| `target/release/bundle/nsis/GeoCode-Web-SingleBin_1.14.0_x64-setup.exe` | 13,361,707 bytes |
| `target/release/bundle/msi/GeoCode-Web-SingleBin_1.14.0_x64_ja-JP.msi` | 22,159,360 bytes |

単体exeのSHA256は`efa4c3a0e9867c3da85673f92976ceccaa9dfca61483c8bac5c2044f61b675de`。版番号は既存の1.14.0を維持しており、新しい公開リリース・署名・インストールは行っていない。利用者の実設定や実DBを使う実機起動も行っていない。最終の検証集計と配布物のhashは`target/tilegen-validation/delivery-summary.json`に保存した。
