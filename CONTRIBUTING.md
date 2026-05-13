# GeoCode-Web-SingleBin への貢献ガイド

GeoCode-Web-SingleBin へのコントリビュートを歓迎します。大きな変更に入る前に、まず Issue を作成するか、既存 Issue で方針をすり合わせてください。

> 特に、 macOS/Linux のクロスプラットフォーム対応、などは大歓迎です。

## 範囲

- 対象は Tauri アプリと、その内部で動く Rust/Axum + Vue 3 構成です
- 仕様の基準は `SPECIFICATION.md` です
- PostgreSQL との差分吸収はバックエンド側で行う方針です

## 開発環境構築

推奨環境:

- Rust stable
- Node.js 20.x
- npm
- PowerShell 7 以上
- `sqlx-cli` (`cargo install sqlx-cli --no-default-features --features sqlite`)
- `tauri-cli` (`cargo install tauri-cli --locked --version "^2"`)

`.env.example` を `.env` にコピーして、必要に応じてパスを調整してください。

```powershell
Copy-Item .env.example .env
sqlx database create
sqlx migrate run
npm ci --prefix src_frontend/frontend
npm ci --prefix src_frontend/frontend-mobile
npm ci --prefix src_frontend/frontend-admin
./src_frontend/scripts/frontends-builder.ps1
```

フロントエンドの型チェック:

```powershell
npm run type-check --prefix src_frontend/frontend
npm run type-check --prefix src_frontend/frontend-mobile
npm run type-check --prefix src_frontend/frontend-admin
```

Rust 側の検証:

```powershell
cargo fmt --check
cargo test
```

`cargo clippy` には既存コード由来の警告が残っているため、導入・全体解消は別途段階的に進める想定です。テストコードは現状、整備が進んでいるとは言えませんが、整備を行う方針です。

## プルリクエスト

- 変更理由を PR 本文に書いてください
- UI 変更はスクリーンショットか短い説明を添えてください
- 仕様変更を伴う場合は `SPECIFICATION.md` も更新してください
- リリースノートに値する変更は `release_notes.md` への追記も検討してください
- 関係のない整形やリファクタリングは、機能変更と分けるとレビューしやすいです

## 開発ガイド

- バックエンドでは SQLite 向けの差分吸収を優先し、フロントエンド互換を壊さないでください
- Windows 単体配布を前提にしているため、配布物サイズと依存追加の影響を意識してください
  - 他のプラットフォームへの対応は大歓迎です。
- 既存 API パスには綴り揺れを含むものがあります。互換性を壊す修正は避け、必要なら段階的に移行してください

## 脆弱性に関する問題

脆弱性と思われる内容は、公開 Issue ではなく `SECURITY.md` の案内に従って連絡してください。
