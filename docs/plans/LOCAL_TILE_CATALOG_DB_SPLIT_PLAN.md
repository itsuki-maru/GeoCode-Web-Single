# タイル管理DBの分離計画

作成日：2026-11-12。状態：S0〜S6実装・回帰・隔離ブラウザ受入・Windows配布物作成済み。[実装・検証記録](LOCAL_TILE_CATALOG_DB_SPLIT_PROGRESS.md)を参照。

専用管理画面と管理HTTP操作は、後続の[CLI化とフロントエンド共通化計画](LOCAL_TILE_CLI_AND_FRONTEND_COMPAT_PLAN.md)で撤去・移行する。独立catalog・保存先・生成核・データ保護は維持する。

実装開始時の確認：旧`20261112120000_add_local_tiles.sql`は利用環境へ未適用。ユーザーの指示に従い、本体migration 26とSQLを削除し、打消しmigration・旧データ移送モード・移送履歴の実装は行わない。以下はこの前提を反映した実装計画である。

基準commitは`eb7597da5d7ec5e9aa7789fa8445ab818448a7ba`（`WIP: タイル生成機能を実装`）。確認時の未追跡項目は移植元の`OSM-Tile-Generator/`だけである。

タイル生成用の管理情報を独立したSQLiteへ移し、本体のテーブル設計と`migrations/`をPostgreSQL版と合わせて維持できる構成にする。既に別ファイルのOSM完成DB、PNG、manifestの配置と形式は維持する。

本計画は[本体移植計画](OSM_TILE_INTEGRATION_PLAN.md)の管理情報の保存先、本体migration 26、DB間の連携に関する部分を更新する。移植当初の検証は[移植実装記録](OSM_TILE_PORT_PROGRESS.md)に残す。

## 1. 分離後の保存構成

| 保存内容 | 保存先 | 管理する処理 |
| --- | --- | --- |
| ユーザー、マーカー、図形、背景定義、共有等 | 既存の本体DB | 本体の共通migration |
| データセット登録、描画世代、ジョブ履歴 | 専用の`catalog.sqlite` | ローカル地図専用の初期化・版管理 |
| 道路地物、索引、LOD、取り込みmetadata | `tile_dataset_path/<id>/data.sqlite`等 | 生成核の完成DB形式 |
| PNG、事前生成manifest | `tile_cache_path` | runtimeとキャッシュ公開処理 |
| 取り込みstaging・作業ファイル | `tile_work_path` | importとジョブのライフサイクル |

専用catalogへ移すテーブルは、`local_tile_datasets`・`local_tile_render_profiles`・`local_tile_jobs`の3つである。外部キーは相互参照だけで、本体テーブルへの外部キーはない。

認証、`tileserver_model`、`temporary_urls`等は本体DBに残し、catalogへ複製しない。本体へ列・view・trigger・補助テーブルを追加する方式は採らない。本体DBにタイル固有テーブルを作らない。

## 2. 設定と専用DBの識別

### 保存先

`geocode-web-single.env.json`へ1項目を追加する。

| 項目 | 値 |
| --- | --- |
| JSON名 | `tile_catalog_database_path` |
| 既定 | `~/.geocode-web-single/tiles/catalog.sqlite` |
| 内部環境変数 | `TILE_CATALOG_DATABASE_PATH` |
| 値の形式 | ホームを解決した絶対ファイルパス |
| 反映 | アプリ・`-s`サーバーの再起動時 |

変更例は次のとおり。既存JSONの他の項目は保持する。

```json
{
  "tile_catalog_database_path": "D:/GeoCode/tiles/catalog.sqlite",
  "tile_dataset_path": "D:/GeoCode/tiles/datasets",
  "tile_cache_path": "E:/GeoCode/tiles/png",
  "tile_work_path": "D:/GeoCode/tiles/work"
}
```

catalogの既定値は他の保存先のカスタム指定から派生させない。PNGだけを別ディスクへ移してもcatalogの場所は変わらない。

既存と同じ`ApplicationInitSetup`、Partial、既定値、JSON補完、環境反映、`LocalTileConfig`へ接続する。欠落・nullは既定値で補完し、空値・相対パス・未展開の`~`は拒否する。

### 誤指定と誤初期化の防止

- catalogはPNG・work・完成DB群の配下へ置かず、それらの清掃・取り込み対象と分離する。既定の`tiles/catalog.sqlite`と`tiles/datasets`等の兄弟配置は許可する。
- 本体DB・完成OSM DBと同一ファイルなら書き込み前に拒否する。Windowsの別名・大小文字・リンク等を考慮し、文字列だけでなく実ファイルの同一性を検査する。
- 既存ファイルではcatalog用`application_id`と既知schemaを検査する。既知catalog、空の新規ファイル、無関係なSQLite、壊れたDB、将来版を区別する。
- 無関係なDBへ管理テーブルや識別値を書き込んでcatalog化しない。
- 不正・書込不可・ドライブ未接続時に、別の既定場所へ保存し直さない。
- DBとowner lockのパスを正規化する。書き込み用SQLiteを別hard link経由で開き、排他・journalを分裂させる構成は拒否する。

### 専用schemaと本体との対応

schemaを`src/local_tiles/migrations/`へ置き、専用の版1から管理する。本体の`schema_migrations`、SQLxの`_sqlx_migrations`とは独立した履歴を使う。

3管理テーブルに加え、専用DB内にschema履歴、対応する本体DBの識別を持つ。未知の版やschema不整合を初期化で消さない。catalogは更新可能な管理DBとしてWAL・外部キー検査・有限のbusy timeoutを明示する。読み取り専用のOSM完成DBの制約は変更しない。

初期版では本体DBとcatalogを一対一とする。catalog内に本体DBの正規化パスと実ファイル識別を記録し、異なる本体DBからの共用を拒否する。識別にはWindowsのvolume/file ID、Unixのdevice/inode等を用い、通常更新で変わるsize・mtimeを不変条件にしない。

catalogだけの移設は対応を保つ。本体DBの移設・復元で対応が変わった場合は利用を拒否する。初期版には再対応付けCLIを設けず、必要な場合の再対応付けは別途設計する。パスとfile IDはファイルオブジェクトの検査であり、同じファイルへの内容置換を完全に検出する保証は置かない。

## 3. コードの責務

`LocalTiles.pool`が本体DBと管理DBを兼ねる構成を解消する。

| 層 | 担当 |
| --- | --- |
| `TileCatalog` | 専用DB接続、schema、3テーブルの操作、総件数、孤立job復旧 |
| 本体DBとの連携層 | 認可、背景登録・編集、共有発行、参照確認、本体書込排他 |
| `LocalTiles` | catalogと本体連携を受け取り、描画・ジョブ・公開許可を管理 |
| HTTP handler | 認証・入力・応答変換。用途に合うAPIを呼ぶ |

catalogは内部poolを隠し、用途別APIを提供する。本体poolとcatalog poolを同じ型の引数だけで取り違えない構成にする。起動時の一覧、全catalog操作、service内の管理テーブル直接SQL、jobの登録・進捗・再送・取消・総件数を切り替える。

通常運用のowner lockは専用catalogの設定済み実パスから、完全なファイル名に`.owner.lock`を付けて導出する。拡張子置換による同名衝突を避け、SQLx内部のin-memory URI等をファイル名として扱わない。本体poolは背景・共有・認証の既存操作へ限定する。`ATTACH`で専用DBを本体接続へ結合しない。

テストには一時catalogを明示注入し、既存の外部タイル等のテストが利用者ホームへ暗黙にcatalogを作らないようにする。

## 4. 通常起動の順序

1. 設定を読み、保存先を検査する。
2. 本体DB接続を開く。
3. 本体の共通migrationを実行する。分離直後は25までとなる。
4. 専用catalogを開き、必要なら専用schemaを作成・更新する。
5. catalogと本体連携をruntimeへ注入し、HTTP受付を開始する。

catalog作成・schema変更には専用の排他を取得する。既存ownerがいるプロセスはschema変更・生成を始めず、利用可能な既知catalogを読み取り側として扱う。

catalogだけが利用不能な場合は、ローカル機能を503・管理画面の理由表示に限定し、本体の他機能を利用可能にする。

初回セットアップ後、通常Tauri、`-s`で同じ順序を使う。終了は受付停止、job取消、実worker回収、catalog接続終了、owner解放の順序を維持する。

## 5. DBをまたぐ連携と排他

本体DBの既存`BEGIN IMMEDIATE`を、背景・共有の参照変更と退役を直列化する共通の排他として使う。本体のschema追加は必要ない。

複数DBを一括commit・rollbackできる前提を置かず、通常の業務操作では永続変更先を一つに寄せる。lock順序は、必要なOS owner lock、本体書込transaction、catalog transaction、公開許可の同期、とする。catalogの書込を保持したまま本体書込待ちへ入らない。

| 操作 | 本体DB側 | catalog側 | 確定点 |
| --- | --- | --- | --- |
| データセット・job登録 | 変更なし | 登録・更新 | catalog commit |
| 背景追加・編集 | 書込排他後に背景を保存 | 排他中にactive検査 | 本体commit |
| 保存済み状態を使う共有発行・更新 | 書込排他後に共有を保存 | ローカル背景のactive検査 | 本体commit |
| 退役 | 排他中に背景・共有参照確認 | retiredを保存 | catalog commit |
| PNG清掃 | 排他中に参照なし確認 | retired・実行jobなし確認 | 検査後のファイル清掃 |

### 背景と共有

汎用背景登録・編集と「背景地図に追加」を同じ検査規約へそろえる。先にprofileを作る場合はcatalogの短いtransactionを終え、本体書込排他を取得してactiveを再確認してから背景を保存する。途中失敗による未参照profileは許容し、再実行で重複を防ぐ。

共有スナップショット発行・更新も、既存の本体書込transaction内でactiveを検査する。背景設定更新後に、古い画面から退役済みURLを含む共有を発行する経路も対象にする。通常共有が現在の背景設定を読む契約は維持する。

### 退役と清掃

退役は本体書込排他中に参照なしを確認し、当該handleの公開を止めてcatalogへ確定する。catalog commit後は、本体側の排他解放が失敗しても公開を復活させない。commit成否が不確定ならcatalogを再確認し、確認できるまでは公開を禁止する。

同じ退役要求を冪等に扱い、再起動時もcatalogの状態を正とする。清掃はretired・参照なし・jobなしを確定した後、長いDB transactionを保持せずPNGを削除する。以後の背景・共有登録はretired検査で拒否される。

清掃の中断・再実行では既にないファイルを成功として扱い、本体DB・catalog・完成DB・元PBFを清掃対象へ混ぜない。

## 6. 未適用の本体migrationの撤去

旧タイル用migrationは利用環境へ未適用である。本体の`MIGRATIONS`から26を除き、`migrations/20261112120000_add_local_tiles.sql`を削除する。新しい打消しSQLや、本体DBのテーブル・履歴を削除する起動処理は追加しない。

3テーブルの定義はローカル地図専用schemaの版1へ移す。本体の版は1〜25とし、SQLx用migration一覧にもタイル用SQLを含めない。既存の共通migrationは変更しない。テストの旧SQL参照と26件という期待値を専用schema・25件へ更新する。

当初計画の旧DB診断・backup・移送・marker・再実行用CLIは未適用という前提により不要となった。S3は新規構成への切替検証に読み替え、利用者DBへ旧SQLを適用してから打ち消す工程を作らない。実DBと利用者の設定JSONは実装・検証で操作しない。

## 7. IDと操作の互換性

専用catalogの再起動・保存先変更でdataset ID・render ID・job ID・URL・manifestを再作成しない。完成DBとPNGの形式を変更せず、保持している世代の保存済みPNGをそのまま配信できるようにする。

現行`build.rs`は本体ソース全体を描画build識別へ含めるため、再ビルドで新しい描画世代になり得る。旧profileを保持し、現行契約どおり旧版cache hitを返し、旧版missは410とする。旧profileを現在版で上書きしない。build識別範囲の変更は別の改修とする。

管理画面にcatalogの保存先と利用状態を追加する。設定反映・移設・backupの説明を更新し、DB登録・取り込み・事前生成・再開・取消・背景追加のAPIと基本操作は維持する。

## 8. 実装段階

| 段階 | 主な作業 | 完了条件 |
| --- | --- | --- |
| S0 契約とfixture | 未適用前提、本体schema25と専用schema1、本体対応を固定 | 独立DB・再起動・誤指定・競合の期待結果を定義 |
| S1 専用catalog | 設定、schema、識別、接続、typed API | 単独DBが動き、本体・完成DBの誤指定を拒否 |
| S2 接続と連携 | pool分割、起動、jobs、認可・背景・共有排他 | 管理情報をcatalogだけへ読み書き |
| S3 切替検証 | 独立ファイルで登録・job・再起動・世代の保持を確認 | 本体へ管理情報が混ざらず、専用DBに保持される |
| S4 本体schema復帰 | 未適用の26と旧SQL除去、テスト接続更新 | 本体は共通25まで。打消しSQL・旧SQL参照なし |
| S5 回帰と文書 | 機能・競合・保存先・CI・利用手順 | 受入を満たしSQLx/runtime双方が再実行可能 |
| S6 配布確認 | exe・NSIS・MSI、隔離受入 | 別catalogで実TCP・ブラウザ受入と配布物生成が成功 |

S0で前提を固定し、S1〜S4の分離機構・連携・本体schema復帰を一体で検証してから配布する。Gitコミットはユーザーが行う。

### 主な変更箇所

- `src/local_tiles/catalog.rs`、専用schema、新設定。
- `service.rs`・`jobs.rs`、本体DBとの連携層。
- `src/handler/local_tiles.rs`・`background_maps.rs`・共有発行/検証経路。
- `src/init.rs`・`src/model/common.rs`・`src/config.rs`・`src/main.rs`・`src/router.rs`。
- `src/db/pool.rs`の旧26登録と`migrations/20261112120000_add_local_tiles.sql`。本体へ新規migrationは追加しない。
- 設定・catalog・job・route・migration・ブラウザfixture・管理画面のテスト、利用文書。

## 9. 受入項目

| 分類 | 必須の確認 |
| --- | --- |
| 本体schema | 3テーブルなし。共通テーブル・列・制約を保持し、共通履歴は1〜25 |
| 専用DB | 作成、再起動、版管理、FK、将来版・破損・無関係DBの拒否 |
| 設定 | 旧JSON補完、値保持、絶対パス、日本語・空白・長パス、ドライブ消失、同一ファイル誤指定 |
| 参照競合 | 汎用/専用の背景登録・編集、共有発行・更新と退役を別接続・別プロセスで競合 |
| commit後障害 | catalog退役後の本体排他解放失敗で公開が復活しない。再起動もretired保持 |
| writerとbinding | 二重owner、別本体との共用、稼働中の設定先共有を拒否 |
| 生成 | miss→保存→hit、並行miss、取消・期限・終了、取り込み・事前生成・再開が別catalogで成功 |
| 互換 | 背景・共有・PNG・manifest・再送ID・履歴、認証、外部タイル/Redisを維持 |
| 起動・配布 | 初回・通常Tauri・`-s`、catalog不通時の本体継続、CIのSQLx migration、exe・NSIS・MSI |

本体とcatalogは異なる実ファイルまたは独立したin-memory DBで試験する。同じpoolを誤注入しても通る構成にしない。本体DBだけを読む検査で、タイル操作後も管理3テーブルがないことを確認する。

試験は合成データと一時本体DB・一時catalogで行う。利用者DB・利用者JSONは操作しない。大きなOSM DBの再取り込み・複製・全SHA読取は不要である。

## 参照

- [現行の管理テーブル操作](../../src/local_tiles/catalog.rs)
- [現行の本体DB連携](../../src/local_tiles/service.rs)
- [本体migration実行](../../src/db/pool.rs)
- [背景地図の登録と検査](../../src/handler/background_maps.rs)
- [共有発行](../../src/handler/onetime_url.rs)
- [ローカル地図の利用手順](../LOCAL_TILES.md)
- [元の移植計画](OSM_TILE_INTEGRATION_PLAN.md)
- [元の実装記録](OSM_TILE_PORT_PROGRESS.md)
