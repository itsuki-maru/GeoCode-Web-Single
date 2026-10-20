# 地図分析用テストデータ

Python標準ライブラリで共通JSONを生成し、各版のRust exampleで専用DBに投入します。
既存アプリの検索・CSV出力・地図対象取得を直接呼び出して期待件数を検証します。
本番用の機能・API・共通UIは変更しません。

## データ

| profile | 主ユーザーの対象数 | 履歴回答数 | 最新回答数 |
|---|---:|---:|---:|
| small | 12 | 60 | 12 |
| basic | 36 | 1,188 | 36 |
| normal | 150 | 5,850 | 150 |

別ユーザーに1対象・2回答を追加し、所有権の分離も検証します。各ユーザーには
観測情報／登録情報の共通フォーム、独立したmasterと3つの地域レイヤを作成します。
全対象は通常の地域レイヤに所属させます。登録対象の半数はポリゴンです。
観測値は地域ごとに低・中・高の範囲を持ち、負数・0・小数、状態別の分布、falseを含みます。
作成日時は2026-10-01 00:00:00 UTCから1時間間隔、検索基準日時は2026-10-10 UTCです。
観測日・登録日はUTCの日付です。機器の計測日時専用フィールドは追加しません。

項目ID・型・表示名は `generate.py` の定義を参照してください。
現在のセットは全項目を定義した第1版の回答です。未入力・項目なし・版変更・旧回答・
上限超過等の境界条件セットは今後の追加対象です。

JSONには構造化回答、投稿時スナップショット、適用元、ID、検証条件と期待件数を保存します。
通常投稿と同じ見出し・項目順・エスケープ・真偽値表記で回答ごとのMarkdownを生成し、
マーカーのdetail／図形のproperties.memoへ投稿順で追記します。本文更新日時も最終投稿時刻に揃えます。
検索・集計には引き続き構造化回答を使い、Markdownを再解析しません。
投入は過去日時を再現するためのDB直接書き込みであり、投稿APIのバリデーション検証を代替しません。

## 生成

各リポジトリのルートからPowerShellで実行します。

```powershell
python scripts/analysis-data/generate.py --profile basic --output target/analysis-test/basic.json
python -m unittest discover -s scripts/analysis-data -p 'test_*.py'
```

`--profile small` / `--profile normal` と `--seed` を指定できます。
同じ引数ではID・回答値・JSONを再現できます。乱数ライブラリに依存しない固定生成です。
両版で同じJSONを使えます。JSONにパスワードや接続情報は保存しません。

## SQLite版への投入

SQLite版のルートから実行します。

```powershell
$env:SQLX_OFFLINE = 'true'
$env:ANALYSIS_TEST_PASSWORD = '<検証用の12文字以上・72バイト以下のパスワード>'
cargo run --locked --offline --example analysis_data -- target/analysis-test/basic.json
Remove-Item Env:ANALYSIS_TEST_PASSWORD
```

保存先はリポジトリ配下の固定パスです。利用中DBの設定は参照しません。

- basic: `target/analysis-test/geocode-web.sqlite`
- small / normal: `target/analysis-test/<profile>/geocode-web.sqlite`

アプリと同じ `run_migrations` で初期化し、履歴も登録します。
目視確認用の別起動では、`CREATEDATABASE_PATH` にこのファイルの絶対パスを指定してください。

## PostgreSQL版への投入

PostgreSQL版のルートから実行します。ビルド時のSQLx検証には開発用
`DATABASE_URL` と最新スキーマが必要です。投入先は別変数で明示指定します。

```powershell
$env:ANALYSIS_TEST_DATABASE_URL = 'postgres://<user>:<password>@localhost/geocode_web_analysis_test'
$env:ANALYSIS_TEST_PASSWORD = '<検証用の12文字以上・72バイト以下のパスワード>'
cargo run --locked --offline --example analysis_data -- target/analysis-test/basic.json
Remove-Item Env:ANALYSIS_TEST_PASSWORD
```

small / normalはDB名を `geocode_web_analysis_test_small` / `geocode_web_analysis_test_normal` にします。
それ以外のDB名は接続前に拒否します。DBが存在しない場合は作成し、全マイグレーションを適用します。
接続ユーザーには必要に応じてDB作成権限が必要です。
目視確認用のアプリ別起動では、`DATABASE_URL` に専用DBを指定してください。

## 再実行と検証

同一JSONの再実行では追加投入せず、検索・CSV・地図の14条件を再検証します。
違うJSONは拒否します。別シードは新しい専用検証環境で試してください。
パスワードは初回作成時だけ保存され、再投入では変更されません。

```powershell
cargo run --locked --offline --example analysis_data -- target/analysis-test/basic.json --verify
```

`--verify` はパスワード不要で、マイグレーション・データ投入を実行しません。
地図は取得対象数、CSVは実際のストリーム本文のレコード数・BOM・CRLFを確認します。
CSVセル内改行はレコード数に含めません。0件条件では地図取得を省略します。
第2版のJSONでは、レイヤ設定・全対象の本文とメモ・全構造化回答もDBと照合します。
各CSVのSHA-256を出力するため、修正前後の出力内容も比較できます。

### 投入済み第1版の表示データ修復

旧JSONを保存し、第2版を別ファイルへ生成してから実行します。パスワードは不要です。

```powershell
python scripts/analysis-data/generate.py --profile basic --output target/analysis-test/basic-v2.json
cargo run --locked --offline --example analysis_data -- target/analysis-test/basic-v2.json --upgrade-from target/analysis-test/before-display-fix/basic.json
```

`--upgrade-from`は旧JSONのSHA-256が管理テーブルと一致する場合だけ実行できます。
独立masterの追加、地域レイヤのmaster解除、回答Markdown、本文・メモとその更新日時だけを変更します。
ID・所属・位置・形状・回答値・回答日時・フォーム定義・認証情報は変更しません。
更新対象のDB行も旧JSONと一致することを確認し、手動変更があれば上書きせず全修正をロールバックします。
修復の再実行では追記を重複させず、検証のみ行います。

ログイン名は `analysis_main_<profile>` と `analysis_other_<profile>`、パスワードは初回投入時の指定値です。
主ユーザーで「共通フォーム → フォームからの回答一覧 → 地図で確認」を開きます。
画面の描画・モバイル操作の目視確認は別途必要です。

既存アプリのテーブルがあるのに投入ツールの管理テーブルがないDBは、移行前に拒否します。
自動削除・既存アカウントの書き換えは行いません。失敗時の回答投入はトランザクションで取り消します。
検証環境のアプリ設定・画像保存先・ポートも通常環境と分離してください。

## 初回実装時の確認

- 両版のsmall / basicで、各14条件（合計56条件）の検索・CSV本文・地図対象数が一致
- 生成器の4テストが両版で通過（固定件数・再現性・参照整合性・数値と真偽値の型）
- SQLiteで同一セットの再検証、異なるセットの拒否、検証前後のDBファイルSHA-256一致を確認
- normalは生成器テストのみ。負荷測定、アプリ画面の目視確認、リリースビルドは未実施

## 表示データ修復時の確認

- 両版のsmall / basicを第2版へ更新し、既存の計56条件が通過
- 修復前後の全56 CSVのSHA-256が一致し、列・値・順序を含む出力内容を保持
- 本文・図形メモと全回答の一致、独立master、地域所属を検証対象へ追加
- 生成器の6テストと修復計画の3テストを両版で実施
- 旧JSON・SQLite専用DBバックアップ・修復前後ログは各版の `target/analysis-test/before-display-fix/` に保存


施設24点・管路36本の共通データは `python scripts/analysis-data/generate_infrastructure.py --output target/analysis-test/infrastructure.json` で生成できます。既存の投入ツールを使い、利用中のDBには投入せず専用検証DBで確認してください。
