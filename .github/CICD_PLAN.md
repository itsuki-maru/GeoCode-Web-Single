# CI/CD 計画

このリポジトリは、ソースコードを公開して誰でも閲覧・クローンできる一方で、現時点では、Pull Request による参加はメンテナーが許可したユーザーに限定する方針です。

## 基本方針

- `develop` を通常開発の集約ブランチ、`main` をリリース用ブランチとする
- 作業ブランチからの PR は原則 `develop` に向ける
- リリース時は `develop` から `main` へ PR を作成し、CI 通過とレビュー後にマージする
- PR は許可済みコントリビューター、Collaborator、Organization member からのみ受け付ける
- 外部からの提案は Issue で受け付け、必要に応じてメンテナーが作業ブランチへ反映する
- CI は `develop` / `main` 向け PR と両ブランチへの push で実行し、リリースビルドは `main` 上のタグまたは手動実行に限定する
- Release は draft として作成し、成果物・チェックサム・リリースノートを確認してから公開する

## 現在のワークフロー

| ワークフロー | ファイル                        | トリガー                               | 目的                                      |
| ------------ | ------------------------------- | -------------------------------------- | ----------------------------------------- |
| CI           | `.github/workflows/ci.yml`      | `develop` / `main` 向け PR、両ブランチへの push、手動 | PR と通常開発の検証                       |
| Release      | `.github/workflows/release.yml` | `main` 上の `v*` タグ / 手動           | Windows 向け成果物と draft Release の作成 |

## PR CI

PR CI では以下を確認する。

- 3 系統の Vue フロントエンドの `npm ci`
- 3 系統の Vue フロントエンドの `type-check`
- 3 系統の Vue フロントエンドの `build-only`
- Tauri/Rust に埋め込む `dist/` 成果物の生成
- `cargo fmt --check`
- `cargo test --locked`

`cargo clippy` は既存警告の整理後に必須化する。導入時は `continue-on-error` ではなく、警告を解消してから必須チェックへ追加する。

## GitHub 側で設定すること

公開リポジトリでは、未許可ユーザーによる fork や PR 作成そのものは完全には止められない。そのため、GitHub 側で「Actions 実行」「マージ」「保護ブランチへの push」「リリースタグの作成・更新・削除」を制限し、未許可ユーザーからの提案は Issue またはクローズ対象の PR として扱う。

1. Settings > Actions > General
   - Actions permissions は、必要な GitHub Actions と reusable workflows のみを許可する
   - Workflow permissions は `Read repository contents and packages permissions` を基本にする
   - `Allow GitHub Actions to create and approve pull requests` は無効にする
   - 公開リポジトリの場合、`Approval for running fork pull request workflows from contributors` は `Require approval for all external contributors` を選択する
   - 非公開リポジトリで fork PR を使う場合、`Fork pull request workflows` では `Run workflows from fork pull requests` 以外を原則無効にし、必要な場合のみ `Require approval for fork pull request workflows` を有効にする
1. Settings > Branches
   - `develop` と `main` に branch protection rule を追加する
   - `develop` は作業ブランチからの PR 集約先として保護する
   - `main` はリリース用ブランチとして保護し、原則 `develop` からの PR のみをマージする
   - Require a pull request before merging を両ブランチで有効にする
   - Require status checks to pass before merging で `CI` の各チェックを両ブランチの必須チェックにする
   - Require branches to be up to date before merging を両ブランチで有効にする
   - Require approvals を両ブランチで有効にする
   - Restrict who can push to matching branches を両ブランチで有効にし、メンテナーのみに限定する
   - 必要に応じて Do not allow bypassing the above settings を有効にする
1. Settings > Rules > Rulesets
   - `develop` / `main` 用の branch ruleset を作成し、branch protection rule と同等の要件を Active で管理してもよい
   - `v*` 用の tag ruleset を作成する
   - tag ruleset では Restrict creations と Restrict updates を有効にし、bypass permissions をリリース権限を持つメンテナーまたは Team のみに限定する
   - リリースタグは `main` にマージ済みのコミットに対してのみ作成する
   - 可能であれば Restrict deletions も有効にし、リリースタグの削除を制限する
1. Settings > Collaborators and teams
   - PR を受け付けるユーザーだけを Collaborator または Team に追加する
1. Settings > Moderation options または Interaction limits
   - 必要に応じて Interaction limits を使い、未許可ユーザーからの直接参加を抑制する

## リリース運用

1. `release_notes.md` と `CHANGELOG.md` を更新する
1. 作業ブランチから `develop` への PR を通し、変更を `develop` に集約する
1. リリース時に `develop` から `main` への PR を作成し、CI とレビューを通してマージする
1. `main` 上のリリース対象コミットに `vX.Y.Z` タグを作成して push する、または既存タグを指定して Release workflow を手動実行する
1. draft Release の成果物、SHA-256、リリースノートを確認する
1. 問題なければ Release を公開する

## 今後の整備候補

- `cargo clippy --locked --all-targets` の必須化
- `cargo sqlx prepare --check` による SQLx オフラインメタデータの検証
- Dependabot による GitHub Actions / npm / Cargo 依存更新 PR
- Windows インストーラの簡易起動確認
- 署名付きリリース成果物の作成
