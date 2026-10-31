# SQLite版バックエンドのカバレッジ

前提はRust、`cargo-llvm-cov`、`rustup component add llvm-tools-preview`。フロントエンドのビルド成果物は通常のバックエンドテストと同様に `dist/` に必要です。依存関係が未取得の場合は、下記の `--offline` を外してください。

リポジトリ直下で実行します。

```powershell
python -B scripts/coverage/run_backend.py --offline
python -B scripts/coverage/summarize_backend.py
```

`cargo-llvm-cov` がPATHにない場合は `--llvm-cov C:/path/to/cargo-llvm-cov.exe` を指定します。比較用の改善前計測は、テストを追加する前に `--label baseline` を付けて実行します。

- インメモリSQLiteと、テストが `target/` 内に作る一時DBのみを使用します。開発用の `.env` や通常のSQLiteファイルは使用しません。
- SQLxはオフラインメタデータでコンパイルします。PostgreSQLや外部のRedis・タイルサーバーは不要です。タイルの試験はローカルのテスト用サーバーを起動します。
- 一度に実行するRustテストは1件とし、ファイルを共有する既存テストと環境設定の競合を避けます。単独起動時も各テスト自身が必要な設定を初期化します。
- `--timezone UTC` が既定です。`--timezone Asia/Tokyo` や `--timezone America/Los_Angeles` でも実行できます。SQLiteにはPostgreSQLのセッションタイムゾーン設定はありません。Windowsでは `TZ` の指定だけでOSのタイムゾーンが変更されるわけではありません。
- `src/` を対象とし、Tauri起動処理とソース内の `#[cfg(test)]` もLLVMの生集計に含みます。外部の `tests/`、依存ライブラリ、build.rsは除外します。対象の除外を増やして数値を改善しません。
- 行・関数・regionを計測します。安定版Rustの分岐カバレッジは計測しません。未計測ファイルは100%として扱いません。
- 既存の手動ベンチマーク・ブラウザ確認・PostgreSQL側の成果物が必要なignoredはそのまま残します。テスト失敗やレポート生成失敗は終了コードに反映します。

結果は `target/coverage/current/`（比較用は `baseline/`）のJSON・LCOV・HTML・ログ・実行記録と、`docs/COVERAGE_BACKEND.md` に出力します。ビルド用の `target/coverage-build/` は通常のビルドと分離します。
