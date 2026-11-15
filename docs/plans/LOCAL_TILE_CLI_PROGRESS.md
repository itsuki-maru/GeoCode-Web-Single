# ローカル地図CLI化・フロント共通化の実装記録

実施日：2026-11-12。[修正計画](LOCAL_TILE_CLI_AND_FRONTEND_COMPAT_PLAN.md)のC0〜C6に対応する。実装・自動検証と、利用者による実アプリ確認を区別する。

本書はCLI化時点の記録。後続の[描画世代識別の修正](LOCAL_TILE_RENDER_IDENTITY_PROGRESS.md)で、ビルド来歴と描画互換性を分離した。現在はコメントやCLI等の更新だけでは世代を変えない。

## C0：基準と保護対象

SQLite側の基準はcommit `132155c`、PostgreSQL共通ソースの採用版は`c902196ccdc2c1b347040c003bdcd6517f281bc4`とした。親リポジトリの保存済み792ファイルが採用commitのGit blobと一致することを確認した。

PostgreSQL側のファイル、利用者の設定JSON・本体DB・catalog・完成DB・PNG・履歴、実行中の取り込みには操作していない。既存の`dist/`、各フロントの既存`dist/`、`target/debug`・`target/release`の既存アプリexeは上書きせず、新しい資材とRust出力を`target/cli-frontend-final`、`target/local-tile-cli-build`へ分離した。

本体migration 1〜25とcatalog schema版1は変更していない。データの移送、再取り込み、登録IDやjob IDの変更、旧世代の削除は行わない。

## C1〜C3：同じexeのCLIと通常XYZ

- 設定・Tauri・サーバー初期化より前にGUI、`-s`、`local-tiles`を判定する。helpと引数誤りは設定なしで処理し、CLIは本体migration・seed・初回セットアップを呼ばない。
- JSONの既定補完はメモリ上だけで行う。`config show`はタイル設定だけを出力し、秘密鍵・パスワード等を出力しない。本体DBは既存ファイルと適用済みschemaを確認して開く。
- 取り込み、完成DB登録、世代準備、事前生成・再開、照会・監視・取消、背景登録、利用停止、PNG整理をCLIから内部serviceへ接続した。管理HTTP APIを経由しない。
- 照会は既存catalogのread-only経路を使い、owner取得、schema作成、孤立job復旧、profile作成を行わない。取消のみ条件付き制御更新とし、実行ownerが要求を検出して実workerを回収する。
- 進捗更新で`cancelling`を`running`へ戻さず、完了との競合は公開済み成功を優先する。Ctrl+Cでは処理回収・接続終了・owner解放を待つ。監視のCtrl+Cは監視だけを終了する。
- Windows release版は親consoleへ接続しつつredirect済みhandleを復元する。stdoutは結果、stderrは進捗・診断、watchのJSONはNDJSONとする。
- 世代付き`/local-tiles/<dataset>/<render>/{z}/{x}/{y}.png`を維持した。共通のラスタ背景だけを登録し、既定背景は変更しない。旧世代のPNG hitは利用可能、旧missは410とする。

## C4：共通フロントとバックエンドでの差分吸収

専用管理UI4ファイル、メニュー・ルート・URL定数を撤去し、`GET /local-tiles`と`/admin/local-tiles/*`も撤去した。共通背景管理APIと公開XYZ配信は維持した。

同期対象は`src_frontend/`全体と`src/templates/`。既存同期の5領域外にあるscript・全体仕様も採用版へ合わせた。製品version関連9ファイルの許容箇所と改行だけを正規化し、792ファイルすべてが一致する。同期scriptのGit cwd制約により通常プレビューが停止したため、保存済みソースのblob照合、変更先の衝突確認、同じversion保持規約を用いた限定同期で適用した。証跡は`target/frontend-sync-preview.json`。

既知のmanifest linkだけをHTML配信時・Tera登録前にローカルURLへ変換する。コメント・JS/CSSの文字列・通常リンク・利用者の描画値は変更しない。manifestとアイコンは隔離ビルド資材へ同梱する。

SQLite用の資材集約は共通ソース外の`scripts/build-frontend-assets.ps1`へ移した。出力はworkspaceの`target`配下に限定し、所有記録がない既存領域、リンクされた領域、既存dist・ソースを削除対象にしない。Rustは`GEOCODE_FRONTEND_DIST`、Tauriは`build.frontendDist`のoverrideで同じ隔離資材を使う。

固定採用基準と全件検査は`tests/fixtures/frontend-compat-baseline.json`、`scripts/check-frontend-compat.mjs`へ追加した。余剰・欠落・内容差・不正基準を非0終了とし、親ディレクトリの最新HEADに依存しない。

## C5：自動検証

共通フロントはPC 1,197件・mobile 723件・admin 151件・template-scripts 1,265件、計3,336件が成功した。4系統の型検査・ビルドと隔離資材の集約も成功し、中間`.build`や旧専用画面chunkが残らないことを確認した。

全件互換性検査はPostgreSQL採用版の792ファイルと一致した。互換性checkerと出力保護のNode試験は10件成功、リンク作成権限を必要とする1件はサンドボックスの制約でskipした。CI・releaseのYAML解析も成功した。CIでは固定したPostgreSQLソースを別checkoutし、取得不能なら失敗する。privateの場合の読取専用`FRONTEND_SOURCE_TOKEN`設定はCI文書へ記載した。

Rustは`cargo fmt --all --check`と`cargo check --locked --offline --all-targets`に成功した。全体回帰、最終追加試験、通信試験の再実行を同じ試験単位で集計すると531件成功、6件ignore。ignoreは手動ブラウザfixtureと外部検証資材が必要な既存試験で、実行していない。

全体回帰の初回には既存localhost通信の8件がサンドボックスで失敗した。libとジオコーディング・外部proxy・背景設定の3統合試験群を制限外で再実行し、204件と4件が成功した。通信制限を避ける実装変更は行っていない。

CLIのdebug・release試験7件が成功した。取り込み・再送・計画・事前生成・再開・背景登録・参照保護・清掃、read-onlyとowner競合、別CLIの取消、実exeのhelp・日本語/空白パス・設定/秘密出力保護、PowerShell/cmdのredirect・JSON・終了コードを検証した。別途、同梱manifestとアイコン、PC/mobileのHTML・共有テンプレートの2試験も成功した。合成PBFと一時DB・一時JSONだけを使用した。

Windowsの実際のCtrl+C操作、実Tauriウィンドウ、PC/mobile/印刷のブラウザ操作、インストール後の動作は利用者の確認対象とする。自動試験では取消tokenから実workerの回収・catalog終了までを確認しており、旧管理UIの過去受入結果を今回の成功として流用していない。

## C6：隔離配布物

共通資材と最終コードを使い、exe・NSIS・MSIを`target/local-tile-cli-build/release`へ生成した。NSIS取得がサンドボックスのDNS制限で失敗したため、許可された制限外で同じ出力先へ再実行した。版番号は1.14.0を維持し、既存の配布物は上書きしていない。

| 成果物（同releaseディレクトリからの相対位置） | サイズ |
| --- | --- |
| `geocode_web_single.exe` | 49,356,288 bytes |
| `bundle/nsis/GeoCode-Web-SingleBin_1.14.0_x64-setup.exe` | 11,769,086 bytes |
| `bundle/msi/GeoCode-Web-SingleBin_1.14.0_x64_ja-JP.msi` | 17,149,952 bytes |

単体exeのSHA256は`b57b082dbcdb64129bbeec030fed802c842e1b89dadf3d83180d81b2495cd499`。全成果物のhashと検証集計は`target/local-tile-cli-delivery-summary.json`へ保存した。最終配布用exeを`GEOCODE_TEST_CLI_EXE`へ明示してCLIの7試験を再適用し、取り込み後の`jobs watch --json`がterminal NDJSONを返すことも確認した。試験の前後でexeのhashが変わらないことを照合した。インストール・公開・Gitコミットは行っていない。

主なログは`target/local-tile-cli-full-tests.log`、`local-tile-cli-lib-tests.log`、`local-tile-cli-network-tests.log`、`local-tile-cli-final-tests.log`、`local-tile-cli-release-tests.log`、`local-tile-cli-delivery-tests.log`、`local-tile-cli-package-final.log`。初回全体ログの通信失敗は、再実行ログの成功と区別して残した。

利用方法と安全な切替は[ローカル地図](../LOCAL_TILES.md)を参照する。旧版の取り込みの正常完了を確認し、関連プロセスを正常終了・バックアップしてから新exeへ切り替える。旧版取り込みへ新CLIから取消要求を送らない。
