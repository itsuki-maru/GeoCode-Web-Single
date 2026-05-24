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
- [ ] `npm run type-check --prefix src_frontend/frontend`
- [ ] `npm run type-check --prefix src_frontend/frontend-mobile`
- [ ] `npm run type-check --prefix src_frontend/frontend-admin`

## 補足

- 仕様変更がある場合は `SPECIFICATION.md` を更新
- UI 変更がある場合はスクリーンショットを添付
- 基本的には事前に Issue で提案し、方針をすり合わせてから
