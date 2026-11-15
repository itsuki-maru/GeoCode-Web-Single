# 機能別ドキュメント

GeoCode-Web-Singleの主要機能について、利用手順、現在の処理フロー、設定、API、制約、検証方法をまとめる。対象は本リポジトリのSQLite版。PostgreSQL版と共通の利用操作とSQLite固有の保存・移行方法を記載し、PC・モバイルの違いは各機能の文書内に示す。

## 基本機能

| 文書 | 内容 |
|---|---|
| [アカウントと認証](ACCOUNT_AUTHENTICATION.md) | ログイン、TOTP、認証更新、プライバシー |
| [地図表示](MAP_VIEWING.md) | 通常地図、別画面、背景タイルの取得・描画・切替フロー、表示状態、共有への導線、外部サイト |
| [レイヤとマーカー](LAYERS_AND_MARKERS.md) | 作成・編集・削除、マーカーアイコン |
| [図形と測定](SHAPES_AND_MEASUREMENT.md) | 描画、形状編集、スタイル、距離・面積 |
| [検索とジオコーディング](SEARCH_AND_GEOCODING.md) | オブジェクト検索、住所・座標検索 |
| [ファイル管理](FILE_MANAGEMENT.md) | 画像・PDF・動画、埋め込み、閲覧制御 |
| [データ入出力](DATA_IMPORT_EXPORT.md) | JSON形式、旧形式互換、取り込みの制約 |

## 共有・公開

| 文書 | 内容 |
|---|---|
| [一時共有URL](TEMPORARY_SHARING.md) | 通常共有・PC全画面地図の状態共有、共通1URL枠、期限、パスワード、SQLite移行 |
| [公開入力フォーム](PUBLIC_FORMS.md) | マーカー・図形への第三者からの回答受付 |
| [共通フォーム](COMMON_FORMS.md) | 作成・個別コピー・レイヤ管理、パスワードと解除 |
| [フォーム回答](FORM_ANSWERS.md) | 所有者入力、回答検索・編集、地図確認・CSV |
| [現在位置共有](LIVE_LOCATION_SHARING.md) | 位置送信、履歴、公開ライブマップ |
| [カメラ共有](CAMERA_SHARING.md) | Androidからの映像配信、WebRTC、TURN |
| [公開ライブカメラ](MJPEG_CAMERAS.md) | Raspberry Pi等のMJPEG画像、マーカーポップアップ内の受信制御 |

## 表示拡張・管理

| 文書 | 内容 |
|---|---|
| [重ね合わせタイル](TILE_OVERLAYS.md) | タイル登録、共有、気象庁ナウキャスト |
| [タイル配信プロキシ](TILE_PROXY.md) | 上流APIキー、Redisキャッシュ |
| [ローカル地図](LOCAL_TILES.md) | OSM PBF取り込み、地名・ランドマーク名、表示選択と描画世代、XYZ配信・事前生成、保存先とオフライン利用 |
| [全国の名称付き地図の導入](JAPAN_LOCAL_TILES_SETUP.md) | 初回起動前からのセットアップ、全国データ取得・再取り込みのPowerShellスクリプト、背景登録とオフライン確認 |
| [地図印刷・PDF出力](MAP_PRINTING.md) | PCの通常・全画面・回答・一時共有地図の操作、出力対象と検証 |
| [管理者機能](ADMINISTRATION.md) | ユーザー管理、権限設定、管理機能への案内 |

初めて利用する場合は、アカウントと認証、地図表示、レイヤとマーカーの順に確認する。公開する場合は対象の共有文書とファイル管理を確認する。カメラ共有は現在位置共有の構成を前提とする。

## 導入と保守

サーバ構築・起動・ビルドは[ルートREADME](../README.md)、構成・DB・APIの全体像は[全体仕様](../SPECIFICATION.md)を参照する。フロントエンドの開発・配布は[フロントエンド全体構成](../src_frontend/SPECIFICATION.md)にまとめる。

移植の段階と受入条件は[OSMタイル生成機能の本体移植計画](plans/OSM_TILE_INTEGRATION_PLAN.md)を参照する。現行の利用手順は[ローカル地図](LOCAL_TILES.md)を参照し、計画と実施済み検証を区別する。

タイル管理情報は本体DBから独立したSQLiteへ保存する。[DB分離計画](plans/LOCAL_TILE_CATALOG_DB_SPLIT_PLAN.md)と[実装・検証記録](plans/LOCAL_TILE_CATALOG_DB_SPLIT_PROGRESS.md)を参照する。

専用管理画面を本体CLIへ移した改修は、[CLI化とフロントエンド共通化計画](plans/LOCAL_TILE_CLI_AND_FRONTEND_COMPAT_PLAN.md)と[実装・検証記録](plans/LOCAL_TILE_CLI_PROGRESS.md)を参照する。PostgreSQL版との共通フロントを維持し、管理はコマンド、表示は共通の背景地図設定とXYZ配信を使う。

コメントや描画に関係しない変更でタイル世代が変わる問題は、[描画世代識別の修正計画](plans/LOCAL_TILE_RENDER_IDENTITY_PLAN.md)と[実装・検証記録](plans/LOCAL_TILE_RENDER_IDENTITY_PROGRESS.md)を参照する。ビルド来歴・取り込み互換性・描画互換性を分離し、同じ描画契約のURLとPNGを継続利用する。

道路から建物・土地被覆・水域・海陸・山の陰影・等高線へ拡張した内容は、[地物・標高地形の拡張計画](plans/LOCAL_TILE_FEATURE_EXPANSION_PLAN.md)と[実装・検証記録](plans/LOCAL_TILE_FEATURE_EXPANSION_PROGRESS.md)を参照する。新形式の別完成DBを作り、既存道路DB・PNG・履歴と共通フロントを維持する。現在の取り込み・切替方法は[ローカル地図](LOCAL_TILES.md)を参照する。

JGD2000・JGD2011が混在する国土地理院DEMへの対応は、[混在DEMの取り込み計画](plans/LOCAL_TILE_MIXED_DEM_PLAN.md)と[実装・検証記録](plans/LOCAL_TILE_MIXED_DEM_PROGRESS.md)を参照する。原資料の経緯度・標高を保持する併用方針、事前検査、識別、検証、タイル資産の再作成範囲を定める。

OSM標準風の配色・道路表現、地名・ランドマーク名、生成時の表示選択は、[計画](plans/LOCAL_TILE_OSM_STYLE_AND_LABEL_PLAN.md)と[実装・検証記録](plans/LOCAL_TILE_OSM_STYLE_AND_LABEL_PROGRESS.md)を参照する。`standard-v2`で名称・詳細属性を持つschema3の新完成DBを作り、同じDBから道路・建物・文字・等高線・陰影・言語を選んだ複数の描画世代を使える。既存の道路・地形DB、PNG・履歴とPostgreSQL版との共通フロントを維持する。現行コマンドと四国の取り込み・通常地図／地形付き地図の準備方法は[ローカル地図](LOCAL_TILES.md)を参照する。実資料や配布exeの実測結果は検証記録で確認する。

機能文書は現行実装の説明とし、設定名・既定値・API・制限値を変更した際は関連文書も更新する。機能間で共通する内容は相互リンクで参照する。「レイヤ」はマーカー・図形のグループを指し、「重ね合わせタイル」と区別する。

2026-09-28の整備では、新規14文書をソース・設定・既存仕様と照合した。各文書の「検証手順」は実施すべき確認項目であり、今回の実機試験や本番での動作確認結果ではない。カメラ共有の過去の検証結果は同文書の日付・環境を参照する。
