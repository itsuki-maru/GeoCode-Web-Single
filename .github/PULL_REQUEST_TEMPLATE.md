## 概要

- 何を変えたか

## 背景

- なぜ必要か

## 参加資格

- [ ] このPRはメンテナーが許可したユーザー、Collaborator、またはOrganization memberからのものです
- [ ] 大きな変更の場合、事前にIssueで方針を確認しています

## 確認項目

- [ ] `cargo fmt --check`
- [ ] `cargo test`
- [ ] `node scripts/check-render-compatibility.mjs`（描画・取り込み関連の変更時は互換性判断も記録）
- [ ] `npm run type-check --prefix src_frontend/frontend`
- [ ] `npm run type-check --prefix src_frontend/frontend-mobile`
- [ ] `npm run type-check --prefix src_frontend/frontend-admin`
- [ ] `npm run test:run --prefix src_frontend/frontend`
- [ ] `npm test --prefix src_frontend/template-scripts`
- [ ] `npm run build --prefix src_frontend/template-scripts`
- [ ] `node --test tests/frontend-compat.test.mjs tests/build-frontend-assets.test.mjs`
- [ ] `node scripts/check-frontend-compat.mjs`
- [ ] `./scripts/build-frontend-assets.ps1 -SkipCargoBuild -OutputRoot target/frontend-dist`

## 補足

- 仕様変更がある場合は `SPECIFICATION.md` を更新
- UI 変更がある場合はスクリーンショットを添付
- 基本的には事前に Issue で提案し、方針をすり合わせてから
