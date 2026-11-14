# 全国の地名・ランドマーク付き地図を導入する

GeoCode-Web-Singleを一度も起動していないWindows PCに、日本全国の名称付き地図を取り込み、インターネットに接続せずに表示・XYZタイル配信できる状態にする手順です。旧来の道路地図・文字なし地図を利用している場合も、同じ手順で名称付き地図へ再取り込みできます。

使用するスクリプトは [setup-japan-local-tiles.ps1](../scripts/setup-japan-local-tiles.ps1) です。データ取得、事前確認、取り込み、背景登録をまとめて実行します。スクリプトだけを任意の作業フォルダーへ保存しても利用できます。

## できあがる地図

全国PBFを`standard-v2`で取り込み、道路・建物・土地被覆・水域・鉄道と、地名・主要なランドマーク名を持つ完成DBを作ります。通常地図は`osm-like-v1`、道路・建物・文字を表示、日本語優先、等高線・陰影なしです。別途DEMを指定すると、同じ完成DBから等高線・陰影付きの背景も登録します。

名称はOSMに記録された対象カテゴリから抽出します。市町村・町字・集落、駅・空港・役所・学校・病院・公園・博物館、山・湖・川などが対象です。全店舗名・全建物名・道路名を網羅するものではなく、名称のない地物や密集した名称は表示されない場合があります。日本語は同梱フォントで描くため、オフライン時にフォントを取得する必要はありません。

旧道路DBや`standard-v1`のDBへ名称だけを追加することはできません。元PBFから名称対応DBを作り直します。全国のPNGをあらかじめ作る必要はなく、完成DBから閲覧時に必要なPNGを生成できます。

## 1. アプリとPowerShellを準備する

1. 名称付きタイル生成に対応したWindows x64版を入手します。[リリース一覧](https://github.com/itsuki-maru/GeoCode-Web-Single/releases)のNSIS/MSIインストーラー、または単体の`geocode_web_single.exe`を使用します。公開リリースが未対応の場合は、対応版の配布物を用意してください。対応状況は後述の`Check`で実exeを検査します。
2. インストーラーを実行して導入するか、単体exeを任意のフォルダーへ置きます。WindowsのWebView2が利用できる環境が必要です。
3. PowerShell 7以降を起動します。Windows標準のWindows PowerShell 5.1では、このスクリプトは実行できません。必要に応じて[Microsoftの導入案内](https://learn.microsoft.com/powershell/scripting/install/installing-powershell-on-windows)を参照してください。
4. スクリプトを保存し、以降の例のパスを実際の場所へ変更します。`$exe`はインストーラーではなく、インストール済みの本体exeです。スタートメニューのショートカットのプロパティ等で保存場所を確認できます。

```powershell
$PSVersionTable.PSVersion

$tileScript = 'C:\GeoCode-Tools\setup-japan-local-tiles.ps1'
$exe = 'C:\GeoCode\geocode_web_single.exe'
$data = 'D:\GeoCode-LocalTiles'
$config = Join-Path $HOME '.geocode-web-single\geocode-web-single.env.json'
```

このリポジトリで作業している場合は、ルートフォルダーからスクリプトを指定できます。対応するビルド済みexeがある場合の例です。

```powershell
$tileScript = (Resolve-Path '.\scripts\setup-japan-local-tiles.ps1').Path
$exe = (Resolve-Path '.\target\release\geocode_web_single.exe').Path
```

例のDドライブがなければ、十分な空き容量のある別のパスに変更してください。`-DataDirectory`を省略すると、`$HOME\GeoCode-LocalTiles`を使用します。通常の利用ユーザーと同じWindowsアカウントで作業してください。

スクリプトの実行がポリシーで拒否された場合は、内容を確認したうえで、そのPowerShellセッションに限って次を実行できます。組織で設定されたポリシーがある場合は、その運用に従います。

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
```

大容量の資料を取得する前に、本体exeの名称付き生成への対応だけを確認できます。これはアプリ未起動でも実行できます。`osm_generation_verified`が`True`であることを確認します。`local-tiles`が使えない版や`False`になるexeでは、対応する配布物へ切り替えてから先へ進みます。

```powershell
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding
& $exe local-tiles build-info --json | ConvertFrom-Json |
    Select-Object osm_generation_verified
```

## 2. 通常アプリの初回セットアップを完了する

1. 本体exeをエクスプローラーから起動します。
2. 「初回セットアップ」でアプリタイトル、管理者ユーザー名・パスワード、ログイン試行制限等を設定し、完了します。初期のユーザー名・パスワードはともに`geocodeweb`です。共有するPCやLAN配信では、利用環境に合う管理者パスワードに変更します。
3. 通常画面が表示されるまで待ちます。この段階で設定JSON、本体SQLite DB、初期管理者が作成されます。
4. アプリを正常終了します。サーバー単体モードを起動している場合は、それもCtrl+Cで終了します。

CLIは初回セットアップや本体DBのmigrationを代行しません。設定JSONだけを手作業で作って取り込みを始めることはできません。

標準の作成先は次のとおりです。以降も同じ設定と本体DBを使用します。

```text
%USERPROFILE%\.geocode-web-single\
  geocode-web-single.env.json   設定
  geocode-web.sqlite            本体DB（認証・背景設定等）
  images\                      アップロードファイル
  tiles\                       ローカル地図の利用時に作成
    catalog.sqlite             タイル管理DB
    datasets\                  完成DB
    png\                       生成済みPNG
    work\                      取り込み作業領域
```

### 任意：取り込み前に生成データの保存先を変更する

全国データの取り込みには、入力PBF、陸域ZIPと展開物、作業DB、完成DB、SQLiteの一時領域、閲覧に伴い増えるPNGの容量が必要です。必要容量と時間はデータ版・DEM範囲・PCで変わるため、一律には保証できません。入力を置くドライブに加え、完成DB・作業領域・catalog・OSの`TEMP`があるドライブの空き容量を確認してください。完成DBの保存先にはhard linkを利用できるファイルシステムを使います。通常のWindowsローカルNTFSドライブが適しています。

`-DataDirectory`はダウンロード資料とスクリプトの記録先です。**アプリの完成DB・PNG・作業領域の保存先は変更しません。** Cドライブの使用を抑えたい場合は、最初の取り込み前に設定JSONを変更します。

アプリと`-s`を終了し、設定をバックアップします。

```powershell
Copy-Item -LiteralPath $config -Destination "$config.before-japan-$(Get-Date -Format yyyyMMdd-HHmmss).bak"
notepad.exe $config
```

既存JSONの他の項目を保持し、次の4項目の値を変更して保存します。この抜粋でファイル全体を置き換えないでください。絶対パスを指定し、JSON内の区切りには`/`を使うとエスケープが不要です。

```json
{
  "tile_catalog_database_path": "D:/GeoCode-Tiles/catalog.sqlite",
  "tile_dataset_path": "D:/GeoCode-Tiles/datasets",
  "tile_cache_path": "D:/GeoCode-Tiles/png",
  "tile_work_path": "D:/GeoCode-Tiles/work"
}
```

`datasets`・`png`・`work`は同じ場所や互いの配下へ置かず、catalogもその中へ置きません。`.env`への追記は不要です。すでにタイルを作成済みの場合は、値の変更だけでは既存ファイルは移りません。[保存先の移設・バックアップ](LOCAL_TILES.md#保存先を移設する)を先に確認してください。

## 3. オンラインで全国PBFと陸域資料を取得する

```powershell
& $tileScript -Action Download -DataDirectory $data
```

`Download`だけは本体exe・設定JSON・初回セットアップを必要としないため、手順2より先に実行しても構いません。全国PBFと世界全体の陸域ポリゴンは大きな資料です。安定した接続と空き容量を確保してください。

| 入力 | 取得先・用途 |
| --- | --- |
| 全国OSM PBF | [Geofabrik Japan](https://download.geofabrik.de/asia/japan.html)の[japan-latest.osm.pbf](https://download.geofabrik.de/asia/japan-latest.osm.pbf)。名称を含むOSM地物を収録 |
| PBF照合値 | [japan-latest.osm.pbf.md5](https://download.geofabrik.de/asia/japan-latest.osm.pbf.md5)。取得したPBFのMD5を照合 |
| 陸域ポリゴン | [OSM land polygons](https://osmdata.openstreetmap.de/data/land-polygons.html)のWGS84・分割版 [land-polygons-split-4326.zip](https://osmdata.openstreetmap.de/download/land-polygons-split-4326.zip)。海陸の下地を構成 |

スクリプトはHTTPリダイレクトに追従し、PBFのMD5照合と陸域ZIPの展開を行います。展開先から`land_polygons.shp`を探し、同名の関連ファイルも保持します。Mercator版や未処理の海岸線データに置き換えないでください。

取得物は`$data\inputs\日時-識別子\`へ保存し、成功した資料の絶対パスを`$data\inputs.json`へ記録します。以降の`Check`・`Import`はこの記録を使用します。`Download`を再実行すると新しい取得一式を作り、既存入力を保持したまま、成功時に`inputs.json`を更新します。自動削除・途中ダウンロードの再開は行いません。

更新時刻の競合でPBFとMD5が一致しない場合は停止します。取得処理を再実行し、一致した一式を使用してください。取得中の資料を別の取り込みで同時に使用しないでください。

### 取得済み資料やオフライン搬入資料を使う場合

ダウンロード済みPBFと、展開済み陸域資料の`.shp`を直接指定できます。`.shp`だけをコピーせず、配布物の同名`.prj`・`.shx`・`.dbf`等も同じフォルダーへ保持します。次の2つの引数を、以降の`Check`と`Import`の両方へ付けます。

```powershell
$source = @{
    PbfPath = 'E:\OSM\japan.osm.pbf'
    LandmaskPath = 'E:\OSM\land-polygons-split-4326\land_polygons.shp'
}

& $tileScript -Action Check -ExePath $exe -DataDirectory $data @source
& $tileScript -Action Import -ExePath $exe -DataDirectory $data @source
```

直接指定したPBFは取得元のチェックサムを別途照合してください。スクリプトで取得した入力は、保存されたMD5との照合を行います。

## 4. 事前確認を行う

GUIと`-s`サーバーを終了して実行します。

```powershell
& $tileScript -Action Check -ExePath $exe -DataDirectory $data
```

名称対応の生成認定`osm_generation_verified`、入力資料、設定JSON、本体DB、生成ownerの利用可否を確認します。完成DB等の実際の保存先も確認してください。設定JSONが標準以外の場所にある場合は、以降の`Check`・`Import`・`Publish`へ毎回`-ConfigPath 'C:\設定\geocode-web-single.env.json'`を付けます。

`Check`は入力ファイルと陸域の関連ファイルの存在、取得記録があるPBFのMD5、任意DEMのヘッダー等を確認します。全国PBFの全走査・地物構築、陸域のCRS・幾何形状や全DEM標高の本検査は取り込み時に行います。全国取り込みの所要時間・空き容量を保証する処理ではありません。

## 5. 全国の名称付き地図を取り込み、背景登録する

```powershell
& $tileScript -Action Import -ExePath $exe -DataDirectory $data `
    -Name '全国・名称付き'
```

完了までPowerShellを開いたまま待ちます。スクリプトは事前確認に続き、次を実行します。

1. 新しい受付UUIDを作り、`import --features standard-v2`で全国PBFと陸域資料を取り込みます。DEMなしでは`--contour-data off`を指定します。
2. 取り込みの終了コードと`state=succeeded`、完成DBの名称収録能力を確認します。
3. 日本語優先・文字ありの通常描画世代を準備します。
4. その`render_id`を明示して「全国・名称付き」を背景に追加し、XYZ URLを記録します。

不正な面は`--invalid-areas skip-feature`で地物単位に除外します。欠損Nodeは既定の`error`で停止します。完了後、`datasets show`の`info.details.labels`で名称数・カテゴリ・除外理由を確認してください。全国取り込みでも、元のOSMデータと描画の制約により全名称を表示するものではありません。

進捗・診断は画面の標準エラーへ、各CLIのJSON結果は`$data\logs\run-...\`へ保存します。成功時の`result.json`には`dataset_id`、通常地図の`render_id`・背景登録結果・URL、地形を指定した場合はその結果も含まれます。画面に表示された保存先を控えてください。

```powershell
# 実行完了時に表示されたパスへ置き換える
$resultFile = 'D:\GeoCode-LocalTiles\logs\run-実際の識別子\result.json'
$result = Get-Content -LiteralPath $resultFile -Raw | ConvertFrom-Json
$result.dataset_id
$result.normal.render_id
$result.normal.url.url
```

取り込み中はGUIや`-s`を起動せず、別の取り込み・背景登録・事前生成も開始しません。Ctrl+Cで取り消す場合は、実処理が終了するまで待ちます。取り込み自体の途中再開はできません。

## 6. アプリで選択し、オフライン動作を確認する

1. スクリプトの正常終了後、本体exeを通常起動します。
2. 地図の背景一覧から「全国・名称付き」を選びます。背景登録だけでは既定背景は切り替わりません。
3. 市街地をズーム14〜16程度で表示し、地名・駅・公園などの名称を確認します。低ズームでは主な地名、高ズームでは詳細な名称を表示します。
4. インターネット接続を切り、ローカル背景を選んだまま、まだ表示していない別の地域・ズームへ移動します。完成DBから未生成のPNGを作れることを確認します。
5. アプリを終了・再起動し、再び同じ背景を選んで表示します。

オフライン利用に必要なのは、対応する本体exe・設定JSON・本体DB・catalog・完成DBです。元PBF・DEM・陸域資料は、取り込み後の表示には不要ですが、将来の再取り込みに備えて保管できます。保存PNGは再利用され、未生成分は本体内で生成します。アプリを停止したまま、ブラウザーだけで配信する方式ではありません。

外部背景、外部の住所検索、気象タイル、外部カメラ等はそれぞれ通信が必要です。オフライン確認ではローカル背景を選択し、外部機能に依存する操作を避けます。詳細は[オフラインで利用できる範囲](LOCAL_TILES.md#オフラインで利用できる範囲)を参照してください。

### ブラウザーやLAN内の端末へタイルを配信する

GUIとサーバー単体モードは同時起動せず、どちらかを使用します。ローカルPCだけで利用する場合の例です。

```powershell
& $exe -s '127.0.0.1:3000' | Out-Host
```

サーバーが起動したら`http://127.0.0.1:3000`を開きます。HTTPでログインする場合は、停止中の設定JSONの`"secure_cookie"`を`"false"`へ変更してから起動します。HTTPSを使用する環境では接続構成に合わせて設定してください。

別PC・スマートフォンから使う場合は、`-s '0.0.0.0:3000'`で待ち受け、起動PCのLAN内IPアドレスへ接続します。Windowsファイアウォール等で必要な接続を許可してください。インターネットは不要でも、クライアントと配信PC間のLAN接続は必要です。ローカルタイルURLは匿名取得できるため、待ち受ける範囲は運用に合わせて選びます。終了時はサーバーのPowerShellでCtrl+Cを押します。

別アプリへ渡す絶対XYZ URLは、別のPowerShellから次で確認できます。`url`自体はサーバーを起動しません。

```powershell
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding
& $exe local-tiles url --dataset $result.dataset_id `
    --render $result.normal.render_id --base-url 'http://127.0.0.1:3000' `
    --config $config --json | ConvertFrom-Json
```

## 任意：等高線・陰影付きの背景も作る

地名・ランドマークの表示だけならDEMは不要です。地形も必要な場合は、[国土地理院の基盤地図情報](https://service.gsi.go.jp/kiban/)から対応DEMを取得し、全国PBFの取り込み時に追加指定します。DEMはスクリプトで自動取得しません。

```powershell
$dem = 'E:\DEM\DEM10B'

& $tileScript -Action Check -ExePath $exe -DataDirectory $data `
    -ElevationInput $dem -ElevationDatumPolicy allow-jgd2000-2011

& $tileScript -Action Import -ExePath $exe -DataDirectory $data `
    -Name '全国・名称付き' `
    -ElevationInput $dem -ElevationDatumPolicy allow-jgd2000-2011
```

対応するFGD-GMLのZIP、XML/GML、ディレクトリ、入力一覧JSONを指定します。ZIP内の別ZIPには対応しないため、外側の地域パッケージは事前に展開します。DEM1m、一般GeoTIFF、投影座標のDEMは対象外です。

`Check`と取り込み前に`elevation inspect`を実行します。既定の`strict`は単一CRSだけを受け入れます。上例の`allow-jgd2000-2011`はJGD2000・JGD2011の併用を明示する指定で、原座標・原標高を使い、測地系・標高改定の補正を行いません。JGD2024と旧CRSの混在は受け入れません。資料の版・範囲を確認し、詳しい条件は[入力資料を準備する](LOCAL_TILES.md#入力資料を準備する)を参照してください。

DEM指定時は等高線を収録し、通常地図と「全国・名称付き・地形」の2背景を登録します。収録DEMのない地域に等高線・陰影は描きません。DEMなしで作った完成DBへ後から標高を追加する場合は再取り込みが必要です。DEM・等高線収録済みなら、表示切替のための再取り込みは不要です。

## 任意：必要地域のPNGを事前生成する

全国の高ズーム一括生成は大量のファイルを作るため、このスクリプトでは行いません。オフラインでの初回表示を速くしたい地域は、GUI・`-s`を終了して、枚数を確認してから生成します。次は東京駅周辺の例です。

```powershell
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding

& $exe local-tiles precompute plan --dataset $result.dataset_id `
    --render $result.normal.render_id --bbox '139.73,35.65,139.80,35.71' `
    --min-zoom 12 --max-zoom 15 --max-tiles 10000 `
    --config $config --json | ConvertFrom-Json

# planの枚数・条件を確認してから実行
& $exe local-tiles precompute run --dataset $result.dataset_id `
    --render $result.normal.render_id --bbox '139.73,35.65,139.80,35.71' `
    --min-zoom 12 --max-zoom 15 --max-tiles 10000 `
    --config $config | Out-Host
```

bboxは西・南・東・北の順です。`plan`は枚数確認のみ、`run`は完了まで待ちます。中断した事前生成は、記録されたジョブIDで`local-tiles precompute resume --job ID`を実行できます。取り込みの途中再開とは別機能です。

## 更新・失敗からの復旧

### 広域タイルの生成に失敗する旧版から更新する

全国データの低ズームで同じタイルが500になる場合は、[広域タイルの障害対応](LOCAL_TILES.md#同じ広域タイルが繰り返し500になる場合)を参照してください。広域描画の修正を含む生成認定済みexeへ更新し、正常に取り込み済みの完成DBをそのまま再利用できます。この修正では背景URLと保存済みPNGを維持するため、`Download`・`Import`を繰り返す必要はありません。GUI・`-s`・生成CLIを正常終了してからexeを切り替え、同じ背景の表示を再試行します。

2026-11-14の[修正後の全国DB検証](performance/local-tile-nationwide-fixed-20261114.json)では、広域SQL検索と線の描画処理を改善し、[前回失敗した10枚](performance/local-tile-nationwide-check-20261114.json)を含む同じ抽出132枚がすべて生成できました。完成DBは読み取り専用で使用し、通常地図のSDK・2worker・1枚120秒の条件で確認しています。既存キャッシュに参照PNGがあった11枚も一致しました。

今回のSDK検証では3枚がHTTPの既定待機時間60秒を超え、最長は約94秒でした。初回表示で待機期限となる場合は、必要な範囲を事前生成するか、[実行上限](LOCAL_TILES.md#実行上限)の`local_tile_http_timeout_seconds`を実測に応じて調整して再起動してください。最後の待機要求が終了すると生成も取り消されるため、待機期限後に必ずPNGが完成するとは限りません。検証の対象と条件は上記の結果を参照してください。

### 最新資料で再取り込みする

取り込み・事前生成を終了し、GUI・`-s`を停止してから、`Download`→`Check`→`Import`を再実行します。`Import`は毎回新しい受付UUIDを使います。必要なら`-Name '全国・名称付き・更新日'`などで背景名を分け、完了後にアプリで新しい背景を選びます。元資料を更新せず、旧道路地図から名称付きへ切り替える場合は、既存PBFを指定して`Check`→`Import`を実行できます。

既存DB・PNG・背景・共有・履歴を一括削除する必要はありません。データセットIDは入力内容と取り込み条件から決まるため、同じ資料・条件では同じIDになることがあります。同じタイルURLの背景登録は既存行を再利用し、その表示名は自動変更しません。旧共有を使い続ける場合は、そのURLが参照する完成DB・描画世代・必要なPNGを保持します。

### 取り込み成功後、背景登録まで進めなかった場合

その実行の`logs\run-...\import.json`で、`state=succeeded`と`dataset_id`を確認します。`id`はジョブIDです。**成功した取り込みを繰り返さず**、次で描画準備・背景登録だけを実行できます。

```powershell
& $tileScript -Action Publish -ExePath $exe -DataDirectory $data `
    -DatasetId '取り込み結果のdataset_id' -Name '全国・名称付き'

# DEMと等高線が収録済みで、地形背景も登録する場合
& $tileScript -Action Publish -ExePath $exe -DataDirectory $data `
    -DatasetId '取り込み結果のdataset_id' -Name '全国・名称付き' -Terrain
```

`Publish`には元のPBF・陸域・DEM入力は不要です。指定した完成DBの能力を使います。`-Terrain`はDEM・等高線が収録されたDBに限ります。

### エラーの確認先

| 状況 | 対処 |
| --- | --- |
| 設定JSON・本体DBがない／schema不一致 | 通常GUIでセットアップを完了する。更新時も対応版GUIを一度起動し正常終了する |
| `osm_generation_verified=false` | 名称付き生成が認定されたexeへ切り替える。認定を強制回避する設定はない |
| owner競合・終了コード3 | 同じ保存先を使うGUI・`-s`・別CLIを正常終了し、実処理の終了後に再実行する |
| ダウンロード・MD5不一致 | 接続と空き容量を確認し`Download`を再実行する。失敗した入力を取り込みに使わない |
| DEM検査の拒否 | CRS・入力形式・混在方針を確認する。PBFの取り込みを繰り返す前に検査を通す |
| 取り込み失敗・取消 | ログの取り込み結果と`jobs show`を確認する。途中再開はできず、原因を直した後に`Import`で新規実行する |
| 同じ広域タイルで500になる | 修正済みexeへ更新して既存の完成DBを再利用する。500は期限超過の504と別のため、続く場合は詳細ログの元原因を確認する |
| 背景が一覧にない | 背景登録結果を確認し、必要なら`Publish`。正常終了後にアプリを起動し直す |
| 地名が少ない／一部出ない | `datasets show`の名称件数・カテゴリ・除外理由、ズーム、OSMの元名称を確認する |
| 容量不足・書き込み失敗 | 入力・完成DB・作業・PNG・catalog・OS一時領域を確認する。未確認の作業DBを一括削除しない |

CLIの詳細照会例です。JSONの標準出力へ`2>&1`で診断を混ぜないでください。

```powershell
& $exe local-tiles jobs list --config $config --json | ConvertFrom-Json
& $exe local-tiles jobs show --job '実際のジョブID' --config $config --json | ConvertFrom-Json
& $exe local-tiles datasets show --dataset '実際のdataset_id' --config $config --json | ConvertFrom-Json
```

## データの出典と保管

OSMデータと陸域ポリゴンのライセンス・出典条件を確認し、登録された地図の出典表示を保持してください。[OpenStreetMapの著作権・ODbL案内](https://www.openstreetmap.org/copyright)、[陸域ポリゴンの提供条件](https://osmdata.openstreetmap.de/data/land-polygons.html)、DEM利用時は[国土地理院の利用規約](https://www.gsi.go.jp/kikakuchousei/kikakuchousei40182.html)を参照します。

入力スナップショットとスクリプトのログは自動清掃しません。調査や再取り込みに必要なものを保管し、実行中の処理が参照していないことを確認して整理します。アプリのバックアップは、全プロセスを停止し、設定・本体DB・catalog・完成DBを対応する一式として保全します。詳細な移設・清掃・復元方法は[ローカル地図のCLI管理とXYZ配信](LOCAL_TILES.md)を参照してください。

本書は実行手順です。全国データの実取り込み・GUI表示・ネットワーク遮断の確認は、使用する配布exeとPCで行ってください。
