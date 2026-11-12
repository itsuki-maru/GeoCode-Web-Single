# タイル管理DB分離の実装記録

本書はDB分離時点の検証履歴。後続の[CLI化・フロント共通化](LOCAL_TILE_CLI_PROGRESS.md)で専用管理画面と管理HTTP APIを撤去した。現行操作は[ローカル地図](../LOCAL_TILES.md)を参照する。

実施日：2026-11-12。[分離計画](LOCAL_TILE_CATALOG_DB_SPLIT_PLAN.md)のS0〜S6に対応する。

## 適用前提

旧`20261112120000_add_local_tiles.sql`は利用環境へ未適用であるとのユーザー確認を受け、本体migration 26とSQLファイルを削除した。打消しSQL、本体DBの旧テーブル・履歴を削除する処理、移送CLIは追加していない。利用者の実DB・設定JSONは操作していない。

## S0〜S4：構成と切替

- 本体の共通migrationは1〜25とし、タイル管理3テーブルを作成しない。既存の共通migrationファイルは変更していない。
- `src/local_tiles/migrations/0001_catalog.sql`に専用schemaを置き、`TileCatalog`が独立して接続・初期化する。catalog操作へ本体poolを渡せないAPIにした。
- catalogの既定は`~/.geocode-web-single/tiles/catalog.sqlite`。JSONの`tile_catalog_database_path`と内部環境変数`TILE_CATALOG_DATABASE_PATH`を追加し、既存の画像・タイル保存先と同じ補完・検証・反映経路へ接続した。
- `application_id=0x47574354`、schema版1、checksum、schemaの照合、本体DBの正規化パスとファイル識別で誤指定を拒否する。無関係なSQLite、破損、将来版、同一ファイル、hard link、完成DB・PNG・作業領域との重複を検査する。
- catalogはWAL・外部キー検査・有限の待機時間を使う。新規schema作成と生成ownerのlockは、catalogの完全なファイル名に`.owner.lock`を加えた同じパスを使う。
- 登録・描画世代・ジョブ・総件数・孤立ジョブ復旧はcatalogへ、本体の認証・背景・共有は本体DBへ分けた。起動はcatalog初期化失敗だけで本体全体を停止せず、ローカル機能を503と理由表示にする。
- 背景保存・共有スナップショット発行と退役は、本体の`BEGIN IMMEDIATE`を共通の排他にする。catalog初期化は本体transaction前に済ませ、transaction中にactiveを再検査する。
- catalogで退役が確定した後は、本体側の排他解放に失敗しても公開を復活させない。新しいprofileの挿入も同じSQLで親datasetの退役状態を継承し、退役後も清掃できる。
- 正規化でローカルURLへ到達する相対URLの別名を拒否する。外部HTTP(S)背景の契約は維持した。
- 終了では管理ジョブの実処理を回収し、catalog接続を閉じてownerを解放する。初期化・終了の呼出元がキャンセルされても内部処理と排他を保持して回収を待つ。close後の遅延初期化・再openを拒否する。

独立した実ファイルの本体DBとcatalogを使い、PBF取り込み・事前生成・元PBF削除・再起動後のID／URL／ジョブ履歴保持を確認した。本体DBにタイル管理テーブルがないこと、catalogに本体テーブルがないことを照合した。

本体DBの移動・置換・復元でbindingが変わる場合は自動再対応付けしない。初期版には再対応付けCLIを含めない。同じ本体DBを保ったcatalog単独の移設は試験した。

## S5：回帰と利用文書

Rust全体回帰は`cargo test --locked --offline --lib --bins --tests -- --test-threads=4`で50スイート・508件成功、6件ignore。最終レビュー後に、ローカル機能・本体schema・背景・共有・既存handlerを含む16スイート・311件を再実行し、成功した（2件ignore）。

専用catalogの11統合試験は、独立schema、原子性、外部キー、ownerを確認したジョブ復旧、未知・破損・将来版・改変schema、本体DBとの同一性、別本体、catalog単独移設、初期化排他、終了競合、保存領域、in-memory pool識別を対象とする。別接続での参照変更と退役、退役確定後の障害、初回catalog初期化と1接続の本体poolの競合も回帰に含めた。

終了処理の追加検証では、初期化・終了の呼出元が途中でキャンセルされても内部処理を回収する試験を追加した。その過程で、SQLx 0.8.6のpool終了と接続返却が競合すると`is_closed=true`でもidle接続が残り、Windowsで直後のcatalog移動に失敗することを確認した。poolの残接続数が0になるまで終了処理で回収し、同じ返却順序を再現する試験を追加した。待機時間の追加で隠す処理は入れていない。

この修正後、ローカル機能のunit 10件と、catalog・設定・実ファイル分離・参照保護・ジョブ・配信の統合26件を再実行し、計36件すべて成功した。終了直後のcatalog移動も成功した。

最初のサンドボックス内実行では、既存のlocalhost通信試験4件がtransport失敗した。許可された制限外の環境で同じ試験を再実行し、成功した。実装で通信制限を回避する変更は行っていない。設定試験では新しいcatalog重複検査が先に拒否する場合の期待を修正し、6件成功した。

管理frontendは全16ファイル・172テスト成功。PC・mobile・admin・template-scriptsの型検査とビルド、Rust埋込資材の組立を、既存node_modulesを使いオフラインで実施した。管理画面にはcatalogの保存先を追加し、[利用手順](../LOCAL_TILES.md)の設定・バックアップ・移設説明を更新した。

## S6：隔離したブラウザ受入

統合routerの実TCPサーバーとheadless Edgeで、管理UIのcatalog保存先表示、PBF取り込み、プレビュー、背景追加、事前生成、PNG集計、PC地図、モバイル地図、匿名共有、印刷PDFを確認した。取り込み後に元PBFを削除し、外部オリジンへの要求を遮断した。外部要求0・page error 0で成功した。

サーバー終了時にDBを照合し、本体のタイル管理テーブル0、専用catalogのdataset 1件・job 2件を確認した。スクリーンショットの管理画面とモバイル地図も目視確認した。合成PBFは道路1本であり、広域・低ズームの背景だけの表示と、プレビューの道路表示を区別する。

```text
target/local-tile-browser-317f0681-105f-44a0-bfa4-9ed82ac86f55/
  summary.json
  database-separation.json
  admin-desktop.png
  map-desktop.png
  map-mobile.png
  map-shared.png
  map-print.pdf
```

OS全体の回線遮断、インストーラからの新規導入、実際のTauriウィンドウ操作は今回の隔離受入に含めない。

## S6：Windows配布物

終了処理の最終修正と36件の関連回帰後、`cargo tauri build --ci -- --locked --offline`で単体exe、NSIS、MSIを再生成した。初回のサンドボックス内実行ではNSIS資材の取得がDNS制限で失敗したため、許可された制限外で再実行した。`--offline`はCargoの依存解決への指定であり、インストーラ資材の取得まで保証するものではない。

| 成果物 | サイズ |
| --- | --- |
| `target/release/geocode_web_single.exe` | 61,527,040 bytes |
| `target/release/bundle/nsis/GeoCode-Web-SingleBin_1.14.0_x64-setup.exe` | 13,512,091 bytes |
| `target/release/bundle/msi/GeoCode-Web-SingleBin_1.14.0_x64_ja-JP.msi` | 22,298,624 bytes |

単体exeのSHA256は`53c20152ff5cd6a6ee93b397b92e5ceed92899c8c20f736040a0d576eacfbda8`。版番号は1.14.0を維持した。検証集計と全配布物のhashは`target/catalog-split-delivery-summary.json`へ保存した。公開・インストール・Gitコミットは行っていない。
