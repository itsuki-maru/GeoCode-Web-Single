# GeoCode-Web-Single への貢献ガイド

GeoCode-Web-Single への提案を歓迎します。大きな変更に入る前に、まず Issue を作成するか、既存 Issue で方針をすり合わせてください。

このリポジトリはソースコードを公開しており、誰でも閲覧・クローンできます。一方で、Pull Request による参加はメンテナーが許可したユーザー、Collaborator、または Organization member に限定します。未許可ユーザーからの提案は Issue で受け付け、必要に応じてメンテナーが作業ブランチへ反映します。

> 特に、 macOS/Linux のクロスプラットフォーム対応、などは大歓迎です。

## 範囲

- 対象は Tauri アプリと、その内部で動く Rust/Axum + Vue 3 構成です
- 仕様の基準は `SPECIFICATION.md` です
- PostgreSQL との差分吸収はバックエンド側で行う方針です

## 開発環境構築

推奨環境:

- Rust 1.99.1（ローカル地図の認定構成。更新時は画素・取り込み回帰と認定記録を確認）
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
npm ci --prefix src_frontend/template-scripts
./scripts/build-frontend-assets.ps1 -SkipCargoBuild -OutputRoot target/frontend-dist
$env:GEOCODE_FRONTEND_DIST = (Resolve-Path target/frontend-dist).Path
$env:TAURI_CONFIG = @{ build = @{ frontendDist = $env:GEOCODE_FRONTEND_DIST } } | ConvertTo-Json -Compress
```

フロントエンドの型チェック:

```powershell
npm run type-check --prefix src_frontend/frontend
npm run type-check --prefix src_frontend/frontend-mobile
npm run type-check --prefix src_frontend/frontend-admin
npm run build --prefix src_frontend/template-scripts
```

フロントエンドのテスト:

```powershell
npm run test:run --prefix src_frontend/frontend
npm test --prefix src_frontend/template-scripts
```

Rust 側の検証:

```powershell
cargo fmt --check
cargo test
```

ローカル地図の描画・取り込みに関係する変更では、`node scripts/check-render-compatibility.mjs --offline`も実行する。コメント・Rustdocを除いた補助指紋、関連する解決済み推移依存、旧実装から固定した画像を照合する。補助指紋は描画世代には使用しない。

画像を変える修正は`src/tilegen/identity.rs`の該当互換性版を更新する。同じ画素になる最適化・依存更新では、固定画像と取り込み・SDK・世代管理の回帰を確認し、据え置く理由を記録する。確認後の記録更新は`node scripts/check-render-compatibility.mjs --offline --record --reason "20文字以上の判断理由"`を使う。期待画像を変更後の実装から再生成して合格にしない。実行構成の認定には`res/tile-render-execution.json`も使い、未認定構成を環境変数で強制解除しない。

検証では、専用の1領域を`CARGO_TARGET_DIR`へ指定し、`CARGO_PROFILE_DEV_DEBUG=0`・`CARGO_PROFILE_TEST_DEBUG=0`・`CARGO_INCREMENTAL=0`をプロセス限定で設定すると、大きなデバッグ情報や増分キャッシュの蓄積を抑えられる。既存アプリのexe・dist・利用者のDBを検証出力にしない。

`cargo clippy` には既存コード由来の警告が残っているため、導入・全体解消は別途段階的に進める想定です。テストコードは現状、整備が進んでいるとは言えませんが、整備を行う方針です。

## プルリクエスト

- PR は許可済みユーザーからのみ受け付けます
- 通常の作業ブランチからの PR は `develop` に向けてください
- リリース時のみ、メンテナーが `develop` から `main` への PR を作成します
- 変更理由を PR 本文に書いてください
- UI 変更はスクリーンショットか短い説明を添えてください
- 仕様変更を伴う場合は `SPECIFICATION.md` も更新してください
- リリースノートに値する変更は `release_notes.md` への追記も検討してください
- 関係のない整形やリファクタリングは、機能変更と分けるとレビューしやすいです
- PR では GitHub Actions の CI が実行されます。詳細は [.github/CICD_PLAN.md](.github/CICD_PLAN.md) を参照してください

## ライセンスと著作権

このリポジトリへのコード、ドキュメント、画像、設定、その他の貢献を投稿することにより、投稿者は、その貢献をこのリポジトリと同じ MIT License の条件で提供することに同意したものとします。

投稿者は、自身の貢献について必要な権利を有していること、または投稿に必要な許諾を得ていることを確認してください。第三者のコード、画像、データ、文章、生成物を含める場合は、その出典とライセンスを明記してください。

各貢献に関する著作権は、特段の合意がない限り、それぞれの投稿者に帰属します。メンテナーは、投稿された貢献を MIT License に基づき、利用、複製、変更、公開、配布できるものとします。

## 開発ガイド

- バックエンドでは SQLite 向けの差分吸収を優先し、フロントエンド互換を壊さないでください
- Windows 単体配布を前提にしているため、配布物サイズと依存追加の影響を意識してください
  - 他のプラットフォームへの対応は大歓迎です。
- 既存 API パスには綴り揺れを含むものがあります。互換性を壊す修正は避け、必要なら段階的に移行してください

## 脆弱性に関する問題

脆弱性と思われる内容は、公開 Issue ではなく `SECURITY_POLICY.md` の案内に従って連絡してください。
