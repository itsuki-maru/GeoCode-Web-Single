# 変更履歴

## Version 1.0.3

### GeoCode-Web (PostgreSQL版) の更新を反映

- 図形の計測機能で、隣接する2辺を合算して表示する機能を実装（視認性向上）
- ./src/templates/ 配下の HTML を大規模リファクタリング（共通 JS を分離）
  - ビルドスクリプトを更新

## Version 1.0.2

- 図形描画モード時のカーソルをペンに変更
  - assets.rs を svg 配信に対応
  - ビルドスクリプトを更新

## Version 1.0.1

PostgreSQL版 GeoCode-Web の修正を反映

- フロントエンドのパッケージ依存関係を更新
- モバイルUIの画面マージンを修正
- 共有マップでセルフホストなど X-API-KEY を使用したタイルサーバへアクセスできない問題を修正
  - Cookie をフレキシブルとして扱う方針に変更

## Version 1.0.0

このプロジェクトの過去の変更履歴は [release_notes.md](release_notes.md) に記録。

OSS として公開後はこの `CHANGELOG.md` が正本。
