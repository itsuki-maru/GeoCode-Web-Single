# ローカル地図のCLI化とフロントエンド共通化計画

作成日：2026-11-12。状態：C0〜C6の実装・自動検証・隔離配布物作成済み。実アプリ・インストール確認は利用者が実施する。[実装・検証記録](LOCAL_TILE_CLI_PROGRESS.md)を参照。

SQLite版の確認基準はcommit `132155c`（`WIP: タイル生成機能を実装`）。追跡ファイルに未コミット変更がなく、未追跡は移植元`OSM-Tile-Generator/`だけであることを確認した。PostgreSQL版は親ディレクトリの保存済みソースと比較した。親リポジトリのGit状態・HEADは権限制約により未確認であり、実装時に採用基準を再確認する。

実装でも実行中の日本PBF取り込み、利用者DB・JSON・PNG、アプリプロセスへ操作しない。ビルド・検証は既存exeとdistを上書きしない隔離出力で行う。

実装時の採用PostgreSQL refは`c902196ccdc2c1b347040c003bdcd6517f281bc4`へ固定した。保存済みの共通ソース792ファイルが同commitのGit blobと一致することを確認し、正規化hashを`tests/fixtures/frontend-compat-baseline.json`へ保存する。

## 1. 修正する設計原則

`src_frontend/`と`src/templates/`の画面・描画コード、APIの利用方法、テンプレート、テストはPostgreSQL版と共通にする。DB、単一バイナリ、ローカル生成の違いはバックエンドとフロント外のビルド処理で吸収する。SQLite判定、機能フラグで隠す専用メニュー、SQLite固有の画面・APIクライアントは残さない。

ローカル地図はSQLite版限定のバックエンド機能として維持する。PBF取り込み・完成DB登録・事前生成・状態確認・取消・利用停止・キャッシュ整理は、本体の同じexeへ追加するCLIから操作する。別バイナリ、外部生成プロセス、管理用の常駐サーバーは追加しない。

地図フロントは、ローカル地図も通常のラスタXYZタイルURLとして利用する。既存の「背景地図設定」と地図の背景選択を共用し、dataset・render・catalog・jobをフロントで解釈しない。

本計画は[当初の移植計画](OSM_TILE_INTEGRATION_PLAN.md)の専用管理UI・管理HTTP API・CLIを設けない方針と、[DB分離計画](LOCAL_TILE_CATALOG_DB_SPLIT_PLAN.md)の専用管理画面に関する部分を更新する。内部生成核、独立catalog、保存先、排他、既存データ保護の方針は維持する。前回までの実装・検証記録は履歴として残す。

## 2. 確認した現状

### フロントエンドの差分

生成物・依存ディレクトリを除き、改行差を正規化して比較した。既存同期の5領域には28ファイル、対象外のビルド手順等を含めると全体で32ファイルの差がある。

| 分類 | 件数 | 計画での扱い |
| --- | --- | --- |
| ローカル地図専用画面・導線・テスト | 9 | 撤去して共通フロントへ戻す |
| 製品version・lockのversion・ライセンス表示版 | 9 | 既存同期の配布メタデータ保持規約を適用する |
| manifest参照先 | 4 | 同じソースを使い、SQLiteバックエンドでローカル配信へ変換する |
| PostgreSQL側の既存印刷・PDF描画仕様と関連テスト・説明 | 6 | 共通フロントの採用版へそろえ、関連回帰を確認する |
| 同期範囲外のPS1・同期README・同期mjs・全体仕様 | 4 | 全体比較に含め、SQLite固有ビルド責務はフロント外へ移す |

ローカル地図固有の追加4ファイルは次のとおり。

- `src_frontend/frontend-admin/src/views/LocalTiles.vue`
- `src_frontend/frontend-admin/src/views/__tests__/LocalTiles.spec.ts`
- `src_frontend/frontend-admin/src/utils/local-tiles.ts`
- `src_frontend/frontend-admin/src/utils/__tests__/local-tiles.spec.ts`

既存ファイルへの専用導線追加は`AdminApp.vue`、`AdminApp.spec.ts`、`router/index.ts`、`router.spec.ts`、`router/urls.ts`の5ファイルである。これらを共通版へ合わせる。

manifestの差はPC・mobileの`index.html`、`temporary-map.html`、`temporary-map-mobile.html`の4か所にある。PostgreSQL版は外部pages.dev、SQLite版はローカルを参照している。これは単に上書きするとオフライン動作が退行する差分として扱う。

### 配信は既にXYZ

現行の公開PNGは次の形式で、通常のXYZタイル要求を受け付けている。

```text
/local-tiles/<dataset_id>/<render_id>/{z}/{x}/{y}.png
```

「x/y/z」は座標を指定する意味として扱い、慣例のURL順`z/x/y.png`を維持する。座標以外のprefixはタイルセットと描画世代を識別するものであり、共通フロントに専用処理を要求しない。

問題はXYZ配信方式よりも、SQLite専用の管理UI・管理操作APIをフロントへ追加していた点である。

## 3. タイルサーバーとしての利用契約

### 通常の背景定義に登録する

CLIは実際のXYZ URL、出典、最小・最大ズーム、描画世代を出力する。既存の背景定義は`kind=raster`、`style_url=null`とし、共通のURL・出典・ズーム・範囲設定だけを使用する。フロント向けJSONへSQLite固有の属性を追加しない。

利用経路は次の2つを用意する。

1. CLIの`url`出力を、共通の「背景地図設定」へ通常の画像タイルURLとして入力する。
2. CLIの`background add`から、同じ通常の背景定義を登録する。これによりローカル地図の準備をコマンドだけで完了できる。既定背景の自動置換は行わない。

同一アプリ内では相対URLを使う。他アプリ向けには`url --base-url http://127.0.0.1:3000`等で絶対URLを出力する。`base-url`は出力用で、配信対象やcatalogの識別を変更しない。通常起動と既存の`-s`が配信を担い、`url`コマンド自体はサーバーを起動しない。

### 既存URL・キャッシュ契約を維持する

既存の世代付きXYZエンドポイントを正式な配信経路として維持する。固定URL`/local-tiles/{z}/{x}/{y}.png`の対象を裏で切り替えるaliasは初期対応に加えない。同じURLへ異なる世代を返すと、保存済みPNG、HTTPの`immutable`キャッシュ、共有スナップショットの地図が混在するためである。

`/tile/{z}/{x}/{y}.png`は従来の外部プロキシとして維持し、ローカル生成への置換や失敗時の外部fallbackはしない。既存のproxy revision・Redis契約も変更しない。

PNGはXYZ・Web Mercator・256px・ズーム0〜22のPNGとし、匿名GETで配信する。同一originでは追加CORSを必要としない。別originの利用は既存のCORS・CSP・HTTPS設定で扱い、SQLite専用の許可拡大をしない。

背景保存・共有発行のactive検査、利用停止時の背景・共有参照検査はSQLiteバックエンドに残す。本体DBの書込transactionを使うDB間の排他と、catalog確定後に公開を復活させない契約も維持する。

## 4. CLIの構成

### 起動と設定

コマンド名は`geocode_web_single.exe local-tiles ...`を案とする。GUI・`-s`・CLIをTauri、`CONFIG`、サーバー初期化より先に構造化して判定する。現行の「任意位置に`-s`があればサーバー」という判定を置き換え、不正引数・モード混在はusageと終了コード2で拒否する。GUIと既存`-s`の利用方法は維持する。

既存の共通セットアップとJSONを使用する。保存先4項目と実行上限は変更しない。CLIから本体migration、初期ユーザー投入、GUIの初回セットアップを暗黙に実行しない。本体DBが存在しない・必要schemaが未適用なら理由を表示して停止する。

`--help`は設定を読まず表示できるようにする。照会系ではJSON補完保存・設定ディレクトリ作成・catalog新規作成を行わない読取経路を用意する。`config show`はタイル用の有効設定だけを表示し、パスワード・暗号鍵等を含む全設定を出力しない。

### コマンド案

| コマンド | 内容 |
| --- | --- |
| `config show` / `status` | 保存先・制限値・catalogとownerの利用状態を照会 |
| `datasets list` / `datasets show --dataset ID` | 登録情報・描画世代・状態を照会 |
| `datasets register --database PATH --name NAME` | 互換完成DBを検査・登録 |
| `datasets prepare --dataset ID` | 完成DBを検査し、現在の描画版のprofileを明示的に準備 |
| `import --input PATH --name NAME [--missing-nodes error\|skip-way]` | PBF取り込みを完了まで実行 |
| `precompute plan` / `precompute run` | bbox・ズーム・上限を確認し事前生成 |
| `precompute resume --job ID` | 既存manifestと条件を照合して事前生成を再開 |
| `jobs list` / `jobs show` / `jobs watch` | 履歴・進捗・最終状態を照会 |
| `jobs cancel --job ID` | 実行元へ協調取消を要求 |
| `url --dataset ID [--render ID] [--base-url URL]` | 登録済み世代のXYZ URLと通常の背景設定情報を出力 |
| `background add --dataset ID` | 共通形式の背景定義を登録・既存登録を再利用 |
| `datasets retire --dataset ID` | 参照確認後に利用停止 |
| `cache scan` / `cache cleanup --dataset ID --render ID` | 明示的な容量調査・利用停止済み世代のPNG整理 |

`plan/run`等のbbox・最小最大ズーム・枚数上限は既存serviceの検査を再利用する。取り込みの受付ID・再送照合も維持する。`datasets prepare`、登録、取り込みはwriter操作であり、`url/list/status`へ暗黙に混在させない。

`url`で`--render`を省略した場合は、現在buildに対応する登録済みprofileを返す。未準備なら`datasets prepare`を案内して停止する。旧世代を使う場合は`--render`で明示し、旧cache hit配信・旧miss 410という条件も出力する。

`precompute plan`はread-onlyとし、準備済みprofileに対する条件検査・枚数算出だけを行う。現行の`plan_precompute → validate_precompute → datasets()`にはprofile作成とowner取得が含まれるため、検査・照会と準備処理を分離する。未準備なら`datasets prepare`を案内し、確認操作で暗黙の書き込みを起こさない。

CLIの実装は`src/local_tiles/cli.rs`等に置き、HTTP handlerではなく内部service/catalogを直接呼ぶ。HTTP管理APIを残してCLIから呼び出す構成にはしない。ローカル操作の権限はOSの設定・ファイルアクセス権で管理し、WebログインのCookieや管理者トークンを要求しない。

### 長時間処理と終了

取り込み・事前生成はforeground実行を既定とし、job IDと進捗を表示して完了まで待つ。`--detach`や独自daemonは設けない。Ctrl+Cは取消要求、実workerの回収、catalog接続終了、owner解放まで行う。強制終了後の孤立job復旧は、次の正当なowner取得時だけ行う。

取り込みは途中再開不可、事前生成は既存manifestによる再開という契約を維持する。完了と取消の競合で、成功済みの結果をcancelledへ戻さない。`jobs watch`のCtrl+Cは監視だけを終了し、別プロセスのjobを取り消さない。

結果はstdout、進捗・診断はstderrへ分ける。`--json`は通常コマンドの最終結果1件、watchでは明示したNDJSONイベント列とする。終了コード案は成功0、実行失敗1、usage2、owner競合3、対象なし4、協調取消130とし、既に成功した処理は成功を優先する。

WindowsのGUI subsystemを維持する同じrelease exeで、親consoleへの接続、リダイレクト済み標準handle、終了コードを検証する。GUI用`AllocConsole`の流用だけで済ませない。PowerShell・cmdからの終了待ちも検証し、GUI実行ファイルの起動仕様により必要な場合は`Start-Process -Wait -PassThru`等の利用方法を文書化する。

## 5. プロセス間の役割と排他

GUI・`-s`の配信プロセスと、CLIの生成writerを同時にownerにしない。writerコマンドはcatalogと保存先の既存lockを取得し、競合時は即時に理由を返す。ownerの強制奪取、実行中プロセスのjobを勝手にinterruptedへ変更する処理は設けない。初期運用では生成・整理時にGUI／`-s`を停止する。

read-onlyの`status/list/show/watch/url/config show/precompute plan/cache scan`は、配信・取り込み中にも利用できる経路を設ける。現行`LocalTiles.initialize()`、`status()`、`datasets()`にはowner取得・job復旧・profile作成があるため、そのまま照会コマンドへ接続しない。既存catalogをread-onlyで開き、業務データ・schema・job状態を変更せず、描画engineを起動しない。

別CLIからの取消だけは、生成ownerを取得せずに許す限定的な制御書き込みとする。既存の`cancelling`状態を条件付きで記録し、job ownerが監視してプロセス内の取消tokenへ反映する。現在のプロセス内tokenだけの方式から変更し、進捗更新で`cancelling`を`running`へ戻さない。terminal jobへの取消は冪等とし、owner不在時に照会側が復旧・完了を偽装しない。新しい制御サーバーやIPC用DBは追加しない。

shutdownは、途中で呼出元が切れても初期化・終了の内部処理を回収する構成と、SQLxの残接続数が0になるまで終了する対策を維持する。

## 6. 共通フロントへ戻す工程

### 専用UIと管理HTTPの撤去

CLIが同等の操作を担えるようになってから、専用4ファイルとメニュー・Vue Router・URL定数・テストの専用部分を撤去する。バックエンドの管理ページ`GET /local-tiles`と`/admin/local-tiles/*`も廃止する。PNGのGET配信経路は維持する。

旧ページ・管理APIへアクセスしても管理SPAや操作機能が残らないことを試験する。標準のnot-found処理・リダイレクトは他の廃止ルートと合わせる。HTTP管理API撤去に伴い、テストは削除だけで済ませず、CLIの同等操作とserviceの回帰へ移す。

### manifest差分をバックエンドへ移す

画面ソース・テンプレートはPostgreSQL側と共通にする。SQLite側のHTML配信処理で、既知の`rel="manifest"`の参照先だけを、同梱する`/assets/manifest-tab.json`・`/assets/manifest.json`へ正規化する方針とする。静的なPC/mobileエントリと、Teraへ登録する共有テンプレートの両方を対象にする。

外部URLをHTML全体で一括置換する方式は採らない。manifest以外のリンク・画像・ユーザー内容を変更せず、HTMLの他の内容と共通ソースは保持する。必要なmanifest・アイコンを同梱し、HTML応答、CSP、local manifestの配信をバックエンド試験で確認する。

### 同期範囲とビルド

既存の`src_frontend/scripts/sync-to-sqlite.mjs`は5領域だけを対象にし、既定ではSQLite側だけのファイルを削除しない。プレビューを確認し、今回撤去するファイルを特定してから削除を含む同期を行う。衝突を強制上書きで回避しない。

`src_frontend/scripts`、`src_frontend/main`、ルートの`src_frontend/SPECIFICATION.md`も比較対象に含める。mainのsourceは現時点で同一であり、distは比較対象外の生成物として作り直す。SQLite固有のPowerShell統合ビルドを、例えばルートの`scripts/build-frontend-assets.ps1`へ移し、`src_frontend`内のビルドscript・共通仕様はPostgreSQL側へ合わせる。

Rust/Tauri制御、`-SkipCargoBuild`、埋込用distの集約、SQLite固有の配布処理と削除対象の安全確認はフロント外のwrapperで担う。README・CONTRIBUTING・CI/release・CI計画の呼出先も更新する。SQLite専用のオプション・分岐を共通フロントへ増やさない。

製品version、package-lockの製品version、ライセンスの製品版表示は、既存同期が保持する配布メタデータとしてキー・表示箇所単位で許容する。SQLite 1.14.0とPostgreSQL 1.40.0を、この改修だけで同じ製品版番号に変更しない。それ以外の画面・描画・API・テンプレート差分は許容しない。

既存の印刷関連6差分はローカル地図追加と別の差分だが、今回の共通化対象として採用版へ合わせる。API契約や印刷・PDFの動作を検証し、差があればバックエンドで吸収する。

共通化の採用基準は実装開始時のPostgreSQL commitへ固定して記録する。CIではその基準ソースを別ディレクトリへ用意し、比較元を明示して検査する。開発者PCの親ディレクトリや移動する最新HEADだけに依存させない。

## 7. 既存データと現在の取り込み

catalogのschema版1、本体migration1〜25、4保存先、完成DB・PNG・manifestの形式は維持する。CLI化のための再取り込み、登録ID・job IDの振り直し、ファイルの自動移動・削除は行わない。本体DBとのbindingと各保存先の同一ファイル検査も維持する。

本体Rustソース全体が現行build識別に入るため、CLI対応の再ビルドで新しい描画世代になり得る。既存profileと旧URLは残し、旧cache hitを配信し、旧missは410とする。新しい描画世代は`datasets prepare`で明示的に準備して、そのURLを通常の背景として登録できるようにする。`url`の照会だけではprofileを作成しない。

現在実行中の日本PBF取り込みはこの計画修正で停止しない。実装版へ切り替える際は、取り込みの正常完了を確認してから全関連プロセスを止め、JSON・本体DB・catalogをバックアップする。完成DB等を維持したまま新CLIで一覧・URL・配信を確認する手順を用意する。

## 8. 実装段階と完了条件

| 段階 | 作業 | 完了条件 |
| --- | --- | --- |
| C0 契約と基準 | PG共通ソースの基準、32差分、CLI・XYZ・互換契約を固定 | 撤去・共通化・backend吸収箇所を区別できる |
| C1 起動基盤 | CLI dispatch、非書込設定読取、Windows stdio・終了コード | help/照会でGUI・待受・本体migrationを起動しない |
| C2 管理CLI | foreground取り込み・事前生成、照会、取消、世代準備、整理 | 既存サービスと排他・取消・終了契約を満たす |
| C3 配信と背景 | URL出力、CLI背景登録、通常XYZ・共有・参照保護 | 共通の背景設定だけで表示でき、旧世代も保持する |
| C4 フロント共通化 | manifest backend吸収、wrapper移設、共通同期、専用UI/API撤去 | 共有コードにSQLite専用分岐・ファイルがなく、offline動作維持 |
| C5 自動検証と文書 | CLI実exe・競合・旧データ・共通画面の回帰、差分検査 | 以下の受入条件を満たし、CLI運用手順が揃う |
| C6 配布と利用確認 | 共通資材をクリーン生成しexe・NSIS・MSIを検証 | 配布物作成とユーザーによる起動確認を区別して記録 |

C1〜C3を作ってからC4でUIと管理APIを撤去し、途中版を現在の取り込み環境へ適用しない。PostgreSQL側のファイル変更・Gitコミットは今回行わない。

## 9. 受入条件

- `src_frontend`全体と`src/templates`のソース集合・内容を比較し、CRLF/LFと上記の配布メタデータだけを正規化して一致する。片側だけのファイルも検出する。node_modules、dist、cache、coverage、Git除外対象の実環境設定は比較から除外する。追跡された設定例・Vite設定等は比較する。
- 既存同期プレビューは差分があってもexit0のため、互換性検査には差分・余剰ファイルがあれば非0になる専用checkを用意する。比較基準が利用不能なら成功扱いにしない。
- 管理メニュー・ルート・APIクライアントにSQLite専用機能がなく、旧管理HTTPからも操作できない。
- 本体release exeでhelp、usage、stdioリダイレクト、JSON/NDJSON、終了コード、設定未作成、空白・日本語パスを確認する。
- 取り込み・登録・枚数計画・事前生成・再開・一覧・監視・取消・背景登録・利用停止・清掃をCLIから実行できる。異常終了や取消で完成前データを公開しない。
- GUI／`-s`／CLI間のowner競合、read-only照会の同時利用、別CLIの取消、進捗とterminal状態の競合、実workerの回収、終了直後のcatalog移設を検証する。
- 共通の背景設定からXYZ URLを登録し、通常の画像要求で生成保存→cache hitとなる。座標外・世代不一致・利用停止・catalog不通を適切に応答する。
- 旧catalog・完成DB・PNG・manifest・job ID・背景・共有を保持する。本体DBにタイル固有テーブルやmigrationを追加しない。
- PC・mobile・通常/スナップショット共有・印刷/PDF・外部proxy/Redis・認証を回帰確認する。同期で取り込む印刷仕様も対象とする。
- SQLite版のHTMLが同梱manifestを参照し、外部通信を遮断しても共通フロントとローカル地図を利用できる。

検証には合成PBF・一時DB・一時設定を使い、利用者の取り込みや実データを操作しない。実アプリ・ブラウザの起動確認とGitコミットはユーザーが担当する。以前のUI受入結果を新しいCLI契約の成功として流用しない。

## 参照

- [ローカル生成サービス](../../src/local_tiles/service.rs)
- [取り込み・事前生成・取消](../../src/local_tiles/jobs.rs)
- [公開XYZ配信](../../src/handler/local_tiles.rs)
- [本体の起動分岐](../../src/main.rs)
- [HTML・テンプレート配信](../../src/lib.rs)
- [現在の利用手順](../LOCAL_TILES.md)
- [元の移植計画](OSM_TILE_INTEGRATION_PLAN.md)
- [DB分離計画](LOCAL_TILE_CATALOG_DB_SPLIT_PLAN.md)
- [DB分離の実装記録](LOCAL_TILE_CATALOG_DB_SPLIT_PROGRESS.md)
- [CLI化・フロント共通化の実装記録](LOCAL_TILE_CLI_PROGRESS.md)
