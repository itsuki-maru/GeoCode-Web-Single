# SQLite版へのフロントエンド同期

PostgreSQL版の保存済みフロントエンドを、プロジェクト直下のSQLite版へ同期する。
Node.js 22以降とGitを使用する。追加のnpmパッケージ、PowerShell、Bashは不要。

## 配置

```text
GeoCode-Web/                         PostgreSQL版のGitリポジトリ
├── src/templates/
├── src_frontend/
│   └── scripts/sync-to-sqlite.mjs
└── GeoCode-Web-Single/              SQLite版の独立したGitリポジトリ
    ├── Cargo.toml
    ├── src/templates/
    └── src_frontend/
        ├── frontend/
        ├── frontend-admin/
        ├── frontend-mobile/
        └── template-scripts/
```

スクリプトは自身の配置からPostgreSQL版のルートを求めるため、実行時のカレントディレクトリには依存しない。
冒頭で、直下の `GeoCode-Web-Single` が実ディレクトリであること、独立したGitリポジトリであること、
`Cargo.toml` の `[package].name` が `geocode_web_single` であること、両版に5つの同期対象ディレクトリがあることを検証する。
不足や誤配置があれば停止し、コピー先を自動作成しない。symlinkやWindowsのjunctionによる配置は受け付けない。

## 実行方法

以下はPostgreSQL版のルートで実行する例。

```sh
# プレビュー（ファイルとGitインデックスは変更しない）
node src_frontend/scripts/sync-to-sqlite.mjs

# 追加・更新を適用（コピー元にないファイルは保持）
node src_frontend/scripts/sync-to-sqlite.mjs --apply

# 削除を含めたプレビュー
node src_frontend/scripts/sync-to-sqlite.mjs --delete

# 追加・更新・削除を適用
node src_frontend/scripts/sync-to-sqlite.mjs --apply --delete

# オプションの説明
node src_frontend/scripts/sync-to-sqlite.mjs --help
```

`--target PATH` も使用できるが、直下の `GeoCode-Web-Single` と同じパスだけを許可する。
相対指定した `--target` は実行時のカレントディレクトリを基準に解決する。通常は指定不要。

表示には追加・更新・削除の候補、保持する各プロジェクトのバージョン、未コミット変更との衝突、件数を含む。
成功したプレビュー・適用は終了コード0、検証エラーや適用失敗は1。
プレビューは衝突があっても一覧を表示して0で終了し、`--apply` は衝突があれば1で終了する。
プレビュー後に適用すると、その時点のファイルから計画を作り直す。

## 同期対象

次のディレクトリ内のソース・設定・公開資材・テスト・ドキュメントを再帰的に対象とする。

- `src/templates/`
- `src_frontend/frontend/`
- `src_frontend/frontend-admin/`
- `src_frontend/frontend-mobile/`
- `src_frontend/template-scripts/`

コピー元はコミット内容ではなく**ディスク上の作業ツリー**。追跡ファイルへの保存済み変更と、Git除外されていない未追跡ファイルを含む。
エディタで未保存の内容は含まない。コピー元のGit除外設定は `.gitignore`、`.git/info/exclude`、グローバル設定を含めて尊重する。
コピー先でGit除外されるパスと衝突する場合は、作成・上書き前に停止する。

コピー先だけにある対象ファイルは、既定では保持し、`--delete` 指定時だけ削除候補にする。
実際の削除には `--apply --delete` の両方が必要。削除するのはファイルだけで、空ディレクトリは残る。

### 保持するバージョン情報

| ファイル                        | コピー先から保持する値                       |
| ------------------------------- | -------------------------------------------- |
| 各 `package.json`               | ルートの `version`                           |
| 各 `package-lock.json`          | ルートの `version` と `packages[""].version` |
| `frontend/public/licenses.html` | `GeoCode-Web Version …` のアプリバージョン   |

4プロジェクトそれぞれのコピー先バージョンを読み込み、コピー元の内容へ反映する。
依存パッケージの版、依存関係、npmスクリプト、ライセンス一覧はコピー元の更新を取り込む。
アプリ自身のバージョンと同じ文字列であっても、依存パッケージの版は置換しない。Cargoのバージョンも書き換えない。

両版の各 `package.json` とlockfileの2か所の版が一致していることを検証する。
lockfileは `packages[""]` を持つ形式2・3に対応する。JSONの破損・不足、バージョンの不一致、
ライセンス中の表示の不足・重複、ライセンス表示とPC版packageの不一致があれば、全件の書き込み前に停止する。
JSONは2スペースインデントで出力する。UTF-8テキストのCRLF/LFだけの差は更新と扱わず、既存ファイルを維持する。
バイナリはバイト列のままコピーする。

### コピーも削除もしないもの

Gitで除外されている未追跡ファイルに加えて、以下は追跡済みでも対象外。

- `node_modules/`、`dist/`、`coverage/`
- `.cache/`、`.vite/`、`.vite-temp/`、`.vitest/`、`.nyc_output/`、`.turbo/`、`.parcel-cache/`
- `playwright-report/`、`test-results/`、`__pycache__/`、`.pytest_cache/`
- `.git/`、`.hg/`、`.svn/`
- `.env` と `.env.*`（例示用の `.env.example` も含む。`env.d.ts` は対象）
- `*.log`、`*.tsbuildinfo`、`*.pyc`、`*.tmp`、`*.temp`、末尾が `~` のファイル
- `.DS_Store`、`Thumbs.db`、同期用の `.sync-to-sqlite-*` 一時ファイル

ルートの `dist/`、`src_frontend/main/`、`src_frontend/scripts/`、Rust・DB・Tauri関連など、
5つの対象ディレクトリの外には書き込まない。SQLite版固有の統合ビルドスクリプトも保持する。

## コピー先の変更とエラー時の扱い

上書き・削除する予定のファイルに、ステージ済み・未ステージ・未追跡・削除・renameを含む未コミット変更があれば、
プレビューに衝突を表示し、適用時は全件の書き込み前に停止する。対象をコミットまたは退避してから再実行する。
同期結果と同じ内容のファイルや、対象外の変更は停止理由にしない。強制上書きオプションは設けていない。

コピー元・コピー先の対象経路にsymlink/junction、通常ファイル以外のもの、ファイルとディレクトリの衝突があれば停止する。
適用直前にもコピー先を再確認する。実行中は対象ファイルを他の処理で編集しない。
適用はファイル単位で一時ファイルから置換し、Gitのadd・commit・reset・checkoutは実行しない。
ディスク容量不足やアクセス拒否など、書き込み途中のOSエラーでは、適用済みのファイルが残る場合がある。
その場合はエラーとコピー先の `git diff` を確認する。一括ロールバックは行わない。

## 同期後の確認

SQLite版側で差分・依存関係・ビルドを確認する。
このコマンド自体はnpmのインストール、フロントエンドやRustのビルド、アプリの再起動を行わない。

```sh
git -C GeoCode-Web-Single status --short
git -C GeoCode-Web-Single diff
```

依存関係の更新がある場合は、SQLite版の各対象プロジェクトで `npm ci` を実行する。
配布用ビルドはSQLite版の既存の統合ビルド手順を使用する。
フロントエンドの同期は、バックエンドAPI・DBスキーマの移植を行うものではない。

## テスト

PostgreSQL版ルートで実行する。Node.js標準のテストランナーを使用し、DBやnpm依存は不要。

```sh
node --test tests/sync-to-sqlite.test.mjs
```

テストはOSの一時ディレクトリに独立したGitリポジトリを作成し、終了時に片付ける。
実際の `GeoCode-Web-Single` に書き込まない。
配置検証、バージョン保持、依存更新、生成物除外、削除指定、未コミット変更の保護、
改行差・バイナリ、リンク経路、プレビューの無変更、再実行時の差分なしを検証する。
