# ローカル地図のCLI管理とXYZ配信

GeoCode-Web-Single本体にOSM PBFの取り込み・地図PNGの生成・配信を組み込んでいる。管理操作は同じexeの`local-tiles`コマンドを使い、地図はPostgreSQL版と共通の背景地図設定から通常のXYZタイルURLとして利用する。別の生成バイナリや管理サーバーは不要。

正式対応はWindows 64bit。画像はXYZ・Web Mercator・256×256pxの不透明PNG、ズーム0〜22。取り込みの既定値は従来の道路専用形式。`--features standard-v2`では、道路・建物・土地被覆・水域・鉄道に加え、地名や主要なランドマーク名を収録する。OSM標準風の`osm-like-v1`スタイルを使い、同じ完成DBから道路・建物・文字・等高線・陰影の表示を選んだ描画世代を作成できる。DEMと陸域データは別途指定する。既存の道路形式と、文字を持たない`standard-v1`も継続利用できる。住所検索・ルーティング、3D建物、全店舗名や全建物名の網羅は対象外。

## 既存環境から切り替える

旧版で取り込み中の場合は、正常完了を確認してから切り替える。現在の取り込みを止めたり、同じPBFを新しい版で重ねて取り込んだりしない。完了後に関連プロセスを正常終了し、後述のバックアップを取って新exeへ切り替える。catalog・完成DB・PNG・manifest・ジョブ履歴は保持する。

最初に通常アプリの共通セットアップを済ませておく。CLIは既存JSONと本体DBを利用し、共通migrationやユーザー作成を暗黙に実行しない。設定が別の場所にある場合は、各コマンドへ`--config "C:/設定/geocode-web-single.env.json"`を付ける。照会ではJSONの既定補完をメモリ上だけで行い、設定ファイル・backupを保存しない。

## コマンドの基本

```powershell
$exe = "C:/GeoCode/geocode_web_single.exe"
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding
& $exe local-tiles --help | Out-Host
& $exe local-tiles config show --json | ConvertFrom-Json
& $exe local-tiles status --json | ConvertFrom-Json
```

GUI版と同じexeなので、PowerShellで終了まで待つ例ではパイプを使用する。スクリプトから終了コードだけを確認する場合は、`Start-Process -Wait -PassThru`等で待機する。結果はstdout、進捗・診断はstderrに出力する。`--json`は最終結果1件、`jobs watch --json`はNDJSONイベント列を出力する。

PowerShellでUTF-8の出力を別の文字コードとして読むと、日本語の文字化けだけでなくJSONの終端が崩れ、`ConvertFrom-Json`が失敗することがある。上の文字コード設定を同じセッションで先に実行し、JSONへ`2>&1`で診断を混ぜない。

生成・登録・世代準備・背景追加・利用停止・清掃を行うCLIと、GUI／`-s`の生成ownerは同時所有しない。writer操作時はアプリとサーバーを正常終了する。競合時は理由を表示して終了し、稼働中ownerを奪わない。`status`、一覧・詳細・監視、`url`、`precompute plan`、`cache scan`は照会だけを行い、稼働中にも使用できる。

## PBFを取り込む

```powershell
& $exe local-tiles import --input "D:/OSM/japan.osm.pbf" --name "日本の道路" | Out-Host
```

コマンドはジョブIDと進捗を表示し、取り込み完了まで待つ。2回のPBF走査、地物・LOD構築、完成検査を経て登録する。元PBFを複製・削除せず、取り込み途中のDBは配信しない。欠損Nodeは既定でエラー停止し、必要な場合だけ`--missing-nodes skip-way`で該当道路全体を除外する。

取り込みの途中再開はできない。再送の同一性を保ちたい場合は、呼出側でUUIDを用意して`--request-id`へ指定する。同じ受付IDと条件なら既存ジョブを返す。条件の変更や、新しい取り込みには別の受付IDを使う。

Ctrl+Cは取消を要求し、実処理の終了と接続解放まで待つ。OSのI/Oや圧縮処理が戻るまで時間がかかる場合がある。強制終了の残骸を一括削除せず、次の正当なownerが不在を確認したjobだけを中断として復旧する。

## 地名・ランドマーク名付きの地図を作る

名称表示には`standard-v2`で新しい完成DBを作る。既存の道路DBや`standard-v1`のDBには必要な名称・独立した地名Nodeが保存されていないため、`datasets prepare`だけでは追加できない。既存DB・PNG・背景・履歴は残し、元PBFから別の完成DBへ1回取り込む。名称対応DBを作成した後の表示切替や言語の変更には、PBFの再取り込みは不要。

### 四国のPBF・混在DEM・陸域から取り込む

通常アプリの初回セットアップを済ませ、GUIと`-s`サーバーを正常終了して実行する。入力の入手・対応形式とDEMの事前検査は、後述の「入力資料を準備する」を参照する。次の絶対パスは保存場所に合わせて変更する。

```powershell
$pbf = 'D:/OSM/shikoku.osm.pbf'
$demInput = 'E:/DEM/DEM10B'
$landmask = 'E:/OSM/land-polygons-split-4326/land_polygons.shp'

$build = & $exe local-tiles build-info --json | ConvertFrom-Json
if (-not $build.osm_generation_verified) {
    $build.execution.osm | ConvertTo-Json | Out-Host
    throw 'このexeでは名称付き地図の生成が認定されていません。'
}

& $exe local-tiles elevation inspect --input $demInput `
  --elevation-datum-policy allow-jgd2000-2011 --json | ConvertFrom-Json

$requestId = [guid]::NewGuid().ToString()
$job = & $exe local-tiles import --input $pbf `
  --name '四国・名称対応' --features standard-v2 `
  --elevation-input $demInput `
  --elevation-datum-policy allow-jgd2000-2011 `
  --landmask-input $landmask --contour-data on `
  --invalid-areas skip-feature --request-id $requestId `
  --json | ConvertFrom-Json

if ($LASTEXITCODE -ne 0 -or $job.state -ne 'succeeded') {
    $job | ConvertTo-Json -Depth 20 | Out-Host
    throw '取り込みが完了していません。'
}
$id = $job.dataset_id
$dataset = & $exe local-tiles datasets show --dataset $id --json | ConvertFrom-Json
$dataset.info.details | ConvertTo-Json -Depth 20
```

最終結果の`id`はジョブID、`dataset_id`が完成DBのID。`info.details.labels`で名称件数・カテゴリ別件数・除外理由、`capabilities`で名称・等高線・標高の収録能力を確認する。文字列や必要なタグがない地物、過大な名称、代表位置を確定できない地物等は表示対象から外れる。`skip-feature`で除外した不正な面の件数も確認する。

### 同じDBから通常地図と地形付き地図を準備する

```powershell
$normal = & $exe local-tiles datasets prepare --dataset $id `
  --style osm-like-v1 --roads on --buildings on --labels on `
  --language ja --contours off --hillshade off `
  --json | ConvertFrom-Json

$terrain = & $exe local-tiles datasets prepare --dataset $id `
  --style osm-like-v1 --roads on --buildings on --labels on `
  --language ja --contours on --hillshade on `
  --json | ConvertFrom-Json

& $exe local-tiles background add --dataset $id `
  --render $normal.render_id --name '四国・通常地図' | Out-Host
& $exe local-tiles background add --dataset $id `
  --render $terrain.render_id --name '四国・地形付き' | Out-Host
```

それぞれの`render_id`は不変の描画設定を表す。同じDBの通常地図と地形付き地図は、異なるURLとPNG保存先で管理する。背景の表示名は描画世代に影響しない。背景追加は既定背景を自動変更しないので、CLI終了後に通常アプリを起動し、共通の背景一覧から利用したい地図を選ぶ。`src_frontend/`・`src/templates/`へSQLite専用画面や表示スイッチは追加せず、PostgreSQL版との互換性を維持する。

必要な範囲だけ事前生成する場合は、対象の描画世代を明示する。次は高松周辺の通常地図の例。未生成PNGは閲覧時にも同じ設定で生成できる。

```powershell
& $exe local-tiles precompute plan --dataset $id --render $normal.render_id `
  --bbox '133.95,34.25,134.15,34.42' --min-zoom 12 --max-zoom 15 `
  --max-tiles 10000 --json | ConvertFrom-Json
& $exe local-tiles precompute run --dataset $id --render $normal.render_id `
  --bbox '133.95,34.25,134.15,34.42' --min-zoom 12 --max-zoom 15 `
  --max-tiles 10000 | Out-Host
& $exe local-tiles url --dataset $id --render $terrain.render_id `
  --json | ConvertFrom-Json
```

### 取り込みと描画のオプション

| `import`の項目 | 既定値 | 内容 |
| --- | --- | --- |
| `--input` / `--name` | 必須 | ローカルPBFの絶対パスと登録名 |
| `--features` | `roads-v1` | `standard-v1`は従来の地物・地形、`standard-v2`は名称・詳細属性を含む新形式 |
| `--elevation-input` | 指定なし | 対応する国土地理院DEM。省略時は標高を収録しない |
| `--elevation-datum-policy` | `strict` | 単一CRSを受け入れる。JGD2000・2011の併用は`allow-jgd2000-2011`を明示する |
| `--landmask-input` | 指定なし | WGS84分割版陸域の`.shp`。海陸の下地に使用する |
| `--contour-data` | `on` | `standard-v2`専用。DEMから等高線を計算してDBへ収録するかを指定する |
| `--invalid-areas` | `error` | `skip-feature`で不正な面全体を除外する |
| `--missing-nodes` | `error` | `skip-way`で必要Nodeが欠損した道路等を除外する |
| `--request-id` | 指定なし | 同一要求の再送を識別するUUID。別の取り込みには新しい値を使う |

| `datasets prepare`の項目 | `osm-like-v1`の既定値 | 内容 |
| --- | --- | --- |
| `--style` | `osm-like-v1` | 新形式のOSM標準風スタイル。旧形式で表示項目を指定しない場合は従来の描画を選ぶ |
| `--roads` | `on` | 道路線の表示 |
| `--buildings` | `on` | 建物の面・輪郭の表示。施設名は`--labels`で別に制御する |
| `--labels` | `on` | 地名・ランドマーク名の表示。`off`でも名称はDBに残る |
| `--language` | `ja` | `ja`・`local`・`en`から名称の優先言語を選ぶ |
| `--contours` | `off` | 収録済み等高線の表示 |
| `--hillshade` | `off` | 収録済み標高から作る陰影の表示 |

新形式で全描画オプションを省略した場合も、上の固定既定設定を使う。`url`・背景登録・事前生成で`--render`を省略したときは、DB形式ごとの固定の既定世代を選び、最後に準備した世代へ自動切替しない。別設定を利用する場合は`--render`を明示する。

`--contour-data off`は取り込み時の計算時間と等高線格納容量を省く指定で、DEM格子は保持する。対して`--contours off`は生成するPNGで等高線を隠すだけで、DBや既存PNGを削除しない。等高線非収録のDBへ`--contours on`を要求すると拒否するため、追加収録には別DBへの取り込みが必要。標高がないDBの`--hillshade on`、名称がない旧DBの`--labels on`も拒否する。等高線収録済みなら表示切替だけでよい。

### 名称の表示範囲

市町村・町字・集落・島、山頂・火山・峠・湖・主要河川、駅・空港・役所・学校・大学・病院・公園・博物館・城跡等を、許可したOSMタグと名称から抽出する。名前がPBFにない場合にオンラインで補ったり、自動翻訳したりしない。市名は低ズームから、町字や施設名は高ズームから表示し、衝突や密度により一部を間引く。河川名は線に沿って曲げず、全体から決めた代表位置へ置く。道路名・道路番号の盾・全店舗名・標高の数値ラベルは対象外。

橋・トンネルの構造による色・太さ・破線の強調はズーム13以上で使い、低ズームは通常道路と同じ表現にする。河川名はWay／Relation単位の代表点へ置くため、同じ川が複数Wayへ分かれている場合は名称が繰り返されることがある。

`ja`は`name:ja → name → int_name → name:en`、`local`は`name`、`en`は`name:en`を優先し、足りない場合は保存済みの別名称を使う。日本語・英数字は同梱のNoto Sans CJK JPで描画し、OSのフォントや起動時のダウンロードへ依存しない。長い名称は所定の改行・短縮・省略を適用し、欠字は固定の代替字形で扱う。

## 従来の地物・地形形式（standard-v1）

この節は、文字のない`standard-v1`と既存DBの利用方法。名称付きの新規地図は上の`standard-v2`を使う。入力資料の条件は両形式で共通する。

### 入力資料を準備する

標準地図の取り込みには元PBFが必要。既存の道路完成DBには建物や面を構築するNode・Relationが保存されていないため、`datasets prepare`だけで地物を増やすことはできない。旧道路DBを残して、新しい完成DBへ取り込む。

| 入力 | 指定方法・用途 |
| --- | --- |
| OSM PBF | `--input`へローカルPBFの絶対パスを指定する。道路、建物、森林・公園・農地等、水域、水路、運行中の鉄道線を抽出する |
| 国土地理院DEM | `--elevation-input`へFGD-GMLのZIP、XML/GML、ディレクトリ、入力一覧JSONの絶対パスを指定する。陰影と等高線に使う |
| 処理済み陸域ポリゴン | `--landmask-input`へWGS84経緯度・2D Polygonの`.shp`を指定する。同名の`.prj`も必要。海と陸の下地に使う |

DEMは[国土地理院の基盤地図情報](https://service.gsi.go.jp/kiban/)から事前に取得する。DEM10Bは全国に提供されるが、現在の読取実装には下記の座標参照系制限がある。対応する資料を確認したうえで、必要地域の5mデータも利用できる。整備範囲・種類は[公式ヘルプ](https://service.gsi.go.jp/kiban/app/help/)と[FAQ](https://service.gsi.go.jp/kiban/app/faq/)を確認する。現在の読取対象は、[配布仕様](https://service.gsi.go.jp/kiban/contents/screen/basismap/documents/FGD_DLFileSpecV5.3.pdf)の対応する地理座標格子。DEM1m、一般GeoTIFF、旧日本測地系・投影座標のDEMには対応しない。

対応する座標参照系は`fguuid:jgd2000.bl`・`fguuid:jgd2011.bl`・`fguuid:jgd2024.bl`。既定の`--elevation-datum-policy strict`では単一のCRSだけを使う。JGD2000・JGD2011が混在する資料は、`--elevation-datum-policy allow-jgd2000-2011`を指定して併用できる。JGD2024を旧CRSと混在させる入力は拒否する。

原資料の経緯度・標高値を使い、測地系補正・標高改定の補正は行わない。原CRSと未補正であることを記録し、JGD2011やWGS84へ変換済みとは扱わない。境界の位置・標高に不整合が残る場合があるため、混在許可の指定は地形背景として原資料を併用する選択となる。[国土地理院の混在案内](https://www.gsi.go.jp/kiban/faq.html)、[日本の測地系](https://www.gsi.go.jp/sokuchikijun/datum-main)

DEM10Bを含め、公式サービスの「最新データ」でも旧測地成果の資料が提供されることがある。ファイル名の日付だけで測地系や測量時期を判断せず、次の事前検査で入力構成を確認する。[国土地理院の提供条件](https://service.gsi.go.jp/kiban/)

今回の旧DEM10Bには、構成点の種別が「その他」のまま有効な標高値を持つ資料がある。XML内のDEM種別が`10mメッシュ（標高）`の場合に限り、「その他」の有限な範囲内の標高値も地形描画へ採用する。`-9999`、水底、データなしは引き続き欠損として扱い、他のDEM種別や種別未宣言の「その他」は採用しない。これは実資料を確認して定めた本アプリの受入範囲であり、「その他」一般を地表と保証するものではない。[旧配布仕様・DEM構成点](https://service.gsi.go.jp/kiban/contents/screen/basismap/documents/FGD_DLFileSpecV5.0.pdf)

自動検査するのは、CRS宣言・格子と、指定した混在方針での受入可否までで、同じCRS内の標高改定版の一致をXMLだけから保証できない。検査範囲は詳細出力の`vertical_validation`にも記録する。入力資料の改定版を確認して準備する。

ZIPは本体内で読めるが、分割ZIP・暗号化ZIP・ZIP内の別ZIPには対応しない。地域パッケージの中にZIPが入っている場合は、通常のファイル展開で外側を展開し、配下にDEM ZIP/XMLがあるディレクトリを指定する。外部のGDAL・PROJ実行ファイルや変換サーバーは不要。

陸域には[OSM由来の処理済み陸域ポリゴン](https://osmdata.openstreetmap.de/data/land-polygons.html)のWGS84版を使う。大きな輪郭の上限を避けるため分割版を選び、ダウンロードした一式を展開して`.shp`を指定する。Mercator版、Polyline、PolygonZ等は受け付けない。地域PBFの海岸線を途中で閉じて海を生成する方式ではない。

DEM・陸域は省略できる。DEM未指定・未収録地域では陰影・等高線を描かず、陸域未指定では中立色の地表を使う。DEM欠損を海や標高0mとみなさない。DEMを明示したのに有効な標高セルが1つもなければ取り込みは失敗する。

### PBFを走査する前にDEMを検査する

```powershell
& $exe local-tiles elevation inspect --input "E:/DEM/" `
  --elevation-datum-policy allow-jgd2000-2011 --json | ConvertFrom-Json
```

この照会には設定JSON・本体DB・タイル管理DBや生成ownerは不要で、入力ファイルも変更しない。未認定の生成環境でも読取検査だけは実行できる。`allowed`、`exit_code`、`error`、CRS別件数、`warnings`を確認する。受入可は終了コード0、方針による拒否は2、読取・構文検査失敗は1、取消は130。

`validation_scope=header-only`はヘッダー検査を意味し、全標高値・CRC・XML終端の検証完了を保証しない。取り込みでもPBF全走査前に同じ事前検査を行い、標高の本読取時に全体を検査する。事前検査後に資料が変わった場合は停止する。既定の`strict`で混在を検出した場合も、PBFの地物構築は始めない。

### 標準形式で新しいDBを作る

アプリと`-s`を正常終了し、必要な空き容量を確保して実行する。最初は都市・山地・海岸を含む小地域のPBFと、その周辺のDEMで必要容量と処理時間を確認する。全国のPBF・全DEM・全ズームPNGを最初から一括生成する必要はない。

```powershell
& $exe local-tiles import --input "D:/OSM/japan.osm.pbf" `
  --name "日本・地物と地形" --features standard-v1 `
  --elevation-input "E:/DEM/" `
  --elevation-datum-policy allow-jgd2000-2011 `
  --landmask-input "E:/OSM/land-polygons-split-4326/land_polygons.shp" `
  --invalid-areas skip-feature --json | ConvertFrom-Json
```

`--features`未指定または`roads-v1`は従来の道路取り込みとなる。DEM・陸域・面の除外方針には`standard-v1`または`standard-v2`が必要。本節の`standard-v1`もPBFを3回走査し、Relation、必要Way、必要Nodeをディスクの作業DBで解決する。複数外周、湖の島、中庭を持つ面も保存する。

不正な面は既定の`--invalid-areas error`で停止する。上の例は`skip-feature`を明示し、欠損member・不正輪郭等の面全体を除外して処理を続ける。欠損した穴だけを捨てたり、足りない辺を直線で埋めたりしない。終了結果の除外件数と診断を確認する。入れ子Relationの再帰展開は未対応。道路用の`--missing-nodes error|skip-way`は従来の意味のまま併用できる。

取り込みは完了まで待ち、完了検査後に新DBを登録する。途中再開はできない。取消、ownerの競合、受付ID、履歴の扱いは道路取り込みと共通で、既存のDB・PNG・過去の要求JSONを新形式へ書き換えない。

### DEMを複数箇所から指定する

ディレクトリ指定では配下の対応XML/GML/ZIPを読み込む。複数の保存先や同解像度資料の採用優先順を指定する場合は、次の入力一覧JSONを用意する。

```json
{
  "files": [
    { "path": "D:/DEM/10m", "priority": 0 },
    { "path": "E:/DEM/5m", "priority": 10 }
  ]
}
```

```powershell
& $exe local-tiles import --input "D:/OSM/japan.osm.pbf" `
  --name "日本・標準地図" --features standard-v1 `
  --elevation-input "D:/DEM/inputs.json" `
  --elevation-datum-policy allow-jgd2000-2011 `
  --invalid-areas skip-feature | Out-Host
```

`files`の要素はパス文字列、または`path`と整数`priority`を持つオブジェクト。相対パスは入力一覧JSONのあるフォルダから解決する。同解像度・同範囲の重複は大きい`priority`を先に採用し、同順位では内容のhashで順序を固定する。ファイルの列挙順や更新時刻で結果を変えない。高解像度と低解像度の重複では、描画・地形生成の規則に従って利用する。

### 内容を確認して背景へ登録する

取り込み結果に表示された新しいdataset IDを設定する。既存道路のIDを流用しない。

```powershell
$id = "新しいDATASET_ID"
& $exe local-tiles datasets show --dataset $id --json | ConvertFrom-Json
& $exe local-tiles datasets prepare --dataset $id --json | ConvertFrom-Json
$url = & $exe local-tiles url --dataset $id --json | ConvertFrom-Json
$render = $url.render_id

& $exe local-tiles precompute plan --dataset $id --render $render `
  --bbox "139.6,35.6,139.8,35.8" --min-zoom 12 --max-zoom 15 `
  --max-tiles 10000 --json | ConvertFrom-Json
& $exe local-tiles precompute run --dataset $id --render $render `
  --bbox "139.6,35.6,139.8,35.8" --min-zoom 12 --max-zoom 15 `
  --max-tiles 10000 | Out-Host
& $exe local-tiles background add --dataset $id --render $render | Out-Host
```

詳細出力の`info.details`で分類別件数・面の除外理由・入力資料・標高情報・海陸処理範囲を確認する。`url`と背景登録は、実際に採用したOSM・国土地理院の出典を共通の背景定義へ設定する。DEM未指定時に国土地理院DEMの使用を表示しない。既定背景は自動変更しないので、CLI終了後に通常アプリを起動し、背景一覧から新しい地図を選ぶ。

`info.details.elevation`には元CRSの一覧とCRS別集計、採用セルを提供したCRS、混在の有無、実効的な処理方式、補正未実施の情報を保存する。全NoDataや重複により採用セルが0になる資料もあるため、入力に含まれたCRSと採用CRSは区別する。混在時の`crs`はnullで、元CRSを単一の別名へ付け替えない。

### 表示範囲と更新

森林・水域はズーム6から、鉄道は9から、多くの土地被覆・等高線は10から、水路は11から、建物は14から表示する。海陸は低ズームにも描画する。等高線は20m刻みを基礎に、ズーム10〜11では500m、12〜13では100m、14以上では20mを表示し、100mごとの線を強調する。数値ラベルは付けない。表示ズームを上げてもDEMの原解像度を超える地形情報が増えるわけではない。

陸域データはPBFから抽出した地物範囲に余白を加えた処理範囲へ利用する。範囲は収録済みOSMデータの網羅範囲を証明するものではなく、詳細出力の`sources`内の`coverage`で確認する。処理範囲外は中立色とし、海陸を確定表示しない。

`standard-v1`はschema=2/geometry=2、名称対応の`standard-v2`はschema=3/geometry=2の別完成DBとなる。従来の道路専用schema=1/geometry=1も引き続き読み取る。標準形式の完成DBは地物・海陸・正規化DEM・必要な標高階層・収録指定した等高線・出典を内包し、新形式は名称候補・詳細属性も保存する。描画時に元PBF・XML・ZIP・Shapefileは不要。DEMだけの追加・差し替えでも、PBFを含めた再取り込みで別DBを作る。原資料は今後の再取り込み用に保管し、既存完成DBへ追記しない。取り込み時には作業DB、新しい完成直前DB、旧新完成DBの併存容量を確保する。

保存先は後述の4項目を継続利用する。新DB内のDEM・等高線も`tile_dataset_path`、作業領域は`tile_work_path`、PNGは`tile_cache_path`へ保存する。標高専用の追加サーバーや別の設定ファイルは設けない。

旧道路背景へ戻す場合は、共通の背景一覧から既存の道路を選ぶ。道路契約v2対応の旧exeへ戻す場合も、取り込み・事前生成の実処理が終了したことを確認し、新アプリを正常終了してから起動する。旧exeでは新形式の取り込み・準備・事前生成再開を行わない。新しい地図の未生成PNGも作れないため、旧道路背景を使う。復帰のために新DB・PNG・履歴を削除する必要はない。

## 完成DBの登録と既存データの利用

互換完成DBがある場合は再取り込みせず登録する。

```powershell
& $exe local-tiles datasets register --database "D:/OSM/data.sqlite" --name "日本の道路" | Out-Host
& $exe local-tiles datasets list --json | ConvertFrom-Json
$id = "DATASET_ID"
& $exe local-tiles datasets show --dataset $id --json | ConvertFrom-Json
```

外部完成DBはコピーせず読み取り専用で参照する。本体が取り込んだ完成DBは設定rootからの相対位置で保持する。登録済みデータの一覧を照会しても、世代を作り直したりジョブを復旧したりしない。

旧識別方式から初めて切り替える場合や、描画契約が変更されて現在の世代が未準備になった場合は、アプリを止めて明示的に準備する。

```powershell
& $exe local-tiles datasets prepare --dataset $id | Out-Host
```

既存dataset ID・旧profile・PNGを保持して、現在の描画版を追加する。同じ収録内容の描画契約を準備するだけなら完成DBや元PBFの再取り込みは不要。道路専用DBへ建物・DEM等を追加する操作ではない。旧識別方式からの初回切替では一度だけ新URLとなり、その後のコメント・整形・CLI・認証等の更新では同じ描画契約のURLとPNGを継続利用できる。

## 通常のタイルサーバーとして使う

```powershell
& $exe local-tiles url --dataset $id --json | ConvertFrom-Json
& $exe local-tiles background add --dataset $id | Out-Host
```

`background add`は本体DBへ通常のラスタ背景定義を追加し、既存の同じURLは再利用する。既定背景は自動変更しない。コマンド終了後に通常アプリを起動し、地図の背景一覧から選択する。

手動で登録する場合は、`url`の出力にあるURL・出典・ズーム値を共通の「背景地図設定」へ入力する。種類はラスタ、最小ズーム0、最大ズーム22。SQLite専用の管理画面や管理HTTP APIは設けていない。

```text
/local-tiles/<dataset_id>/<render_id>/{z}/{x}/{y}.png
```

この通常のXYZ URLへアクセスすると、保存PNGはそのまま返し、未生成PNGは完成DBから生成して保存する。全国分の事前生成を待つ必要はない。まず都市部をズーム14程度で確認する。標準地図の建物・地形も同じURLのPNGへ合成され、追加のフロント設定は不要。

別アプリ向けには絶対URLを出力できる。

```powershell
& $exe local-tiles url --dataset $id --base-url "http://127.0.0.1:3000" --json | ConvertFrom-Json
```

`url`は配信を開始しない。通常アプリか既存の`-s`モードを起動しておく。別PCから使う場合は`-s 0.0.0.0:3000`等で待ち受け、起動PCのIPアドレスを使う。既存外部プロキシ`/tile/{z}/{x}/{y}.png`の設定を変更する必要はない。

`url`で描画世代を省略すると、完成DB形式ごとの固定の既定設定に一致する準備済み世代を返す。未準備なら`datasets prepare`を案内して停止する。通常地図以外の設定は`--render RENDER_ID`で指定する。互換性を確認できない旧世代も明示でき、保存PNGだけを配信しcache missは410となる。旧背景・共有を自動的に新しいURLへ変更しない。

### 世代とビルド来歴の確認

描画世代は、完成DBの識別、明示的な描画互換性版、実際のスタイル値・寸法・色解釈などで決まる。名称対応スタイルでは道路・建物・文字・等高線・陰影の実効設定、使用する言語・固定フォント・配置規則も含める。文字offでは使わない言語やフォントの差を識別へ入れない。コメント、製品版番号、CLI、認証、ログ、保存先、worker数や期限は含めない。新規取り込みのdataset IDも、PBF内容と取り込み互換性・条件から決定し、製品版やビルド来歴を含めない。既存完成DBの識別情報は変更しない。

`url --json`や状態照会では次を確認できる。

| 項目 | 意味 |
| --- | --- |
| `render_compatible` | 保存されたprofileと現在の描画契約が互換である |
| `current_profile_prepared` | 現在と互換性のある世代が既に登録されている |
| `build_id` / `current_build` | profile初回登録時のビルド来歴と、現在のビルドとの一致。個々のPNGの生成元を保証する情報ではない |
| `app_build_id` | 実行中アプリの診断用ビルド識別 |
| `execution.verified` / `execution.reason` | 道路系列の認定状況と理由 |
| `execution.standard.verified` / `execution.standard.reason` | 従来の標準地図系列の認定状況と理由 |
| `execution.osm.verified` / `execution.osm.reason` | 名称付きOSM標準風系列の認定状況と理由 |

`current_build=false`でも`render_compatible=true`なら同じ世代を利用でき、背景の登録し直しは不要。認定した実行構成であれば、未生成PNGも同じURLへ生成でき、事前生成の再開も継続できる。

実行構成はビルド時に`res/tile-render-execution.json`と照合し、結果をexeへ同梱する。道路・従来の標準地図・名称付きOSM標準風の各系列で、依存の確認範囲と認定結果を分離する。フォント処理専用の依存更新で、既存の道路・地形系列の認定を無関係に変えない。未認定のコンパイラ・CPU機能・追加フラグ・関連依存構成では、該当系列の新規取り込み・世代準備・背景追加・miss生成・事前生成を停止する。保存PNGと照会は利用可能で、新規生成要求には503と理由を返す。互換性を強制する環境変数やJSON設定は設けていない。構成の追加は、各系列の固定画像・取り込み・世代管理の回帰を確認して認定記録を更新し、再ビルドする。

設定JSONやDBがない環境でも、実exeの認定状況だけを確認できる。

```powershell
& $exe local-tiles build-info --json | ConvertFrom-Json
```

`build-info`の`osm_generation_verified`・`osm_render_contract`が名称対応系列、`standard_generation_verified`・`standard_render_contract`が従来の標準地図系列を表す。名称用フォントの`family`・`version`・`sha256`・`license`・取得元と、同梱ライセンス本文は`font`に含まれる。

```powershell
$build = & $exe local-tiles build-info --json | ConvertFrom-Json
$build.font | Select-Object family, version, sha256, license
$build.font.license_text
```

## 事前生成と再開

```powershell
& $exe local-tiles precompute plan --dataset $id --bbox "139.6,35.6,139.8,35.8" --min-zoom 12 --max-zoom 14 --max-tiles 10000 --json | ConvertFrom-Json
& $exe local-tiles precompute run --dataset $id --bbox "139.6,35.6,139.8,35.8" --min-zoom 12 --max-zoom 14 --max-tiles 10000 | Out-Host
& $exe local-tiles precompute resume --job "JOB_ID" | Out-Host
```

bboxの順は西・南・東・北。`plan`は条件と枚数の確認だけを行い、profile・job・PNGを作成しない。現在の世代が準備済みであることが前提となる。`run`は取り込みと同じく完了まで待ち、正常PNGを再利用する。`plan`・`run`は`--render RENDER_ID`で世代を明示でき、省略時は完成DBの形式に対応する既定契約を選ぶ。

再開は停止済みの事前生成ジョブに対して行う。データセット・描画世代・範囲・ズーム・manifestを照合し、既にある正常PNGを再利用する。bboxは生成タイルを選ぶ範囲で、画像を切り抜く指定ではない。高ズームの広域生成は大量のファイルになるため、枚数確認後に必要な範囲で開始する。

## 状態確認・取消・利用停止・清掃

```powershell
& $exe local-tiles jobs list --json | ConvertFrom-Json
& $exe local-tiles jobs show --job "JOB_ID" --json | ConvertFrom-Json
& $exe local-tiles jobs watch --job "JOB_ID" --json
& $exe local-tiles jobs cancel --job "JOB_ID" | Out-Host
& $exe local-tiles cache scan --json | ConvertFrom-Json
& $exe local-tiles datasets retire --dataset $id | Out-Host
& $exe local-tiles cache cleanup --dataset $id --render "RENDER_ID" | Out-Host
```

新CLIの取消要求はcatalogへ記録され、実行元が監視して実workerへ伝える。要求の受付と実際の終了は別なので、最終状態まで確認する。監視コマンドのCtrl+Cは監視だけを止め、取り込みを取り消さない。旧版で動作中の取り込みへ新CLIを使った取消操作は行わず、完了後に版を切り替える。

利用停止は背景・保存済み共有の参照中には拒否する。清掃は利用停止済み・参照なし・実行jobなしの場合だけ行い、指定世代のPNGと付属記録だけを削除する。完成DB・本体DB・catalog・元PBFは削除しない。

終了コードは成功0、実行失敗1、引数誤り2、owner競合3、対象なし／未準備4、協調取消130。成功と取消が競合した場合は、既に公開済みの成功を取り消さない。

## 保存先の設定

通常の設定ファイルは`~/.geocode-web-single/geocode-web-single.env.json`。既存の画像保存先と同じJSON設定経路で、次の4項目を独立して指定する。

| JSON項目 | 既定の保存先 | 内容 |
| --- | --- | --- |
| `tile_catalog_database_path` | `~/.geocode-web-single/tiles/catalog.sqlite` | データセット・描画世代・ジョブの管理DBファイル |
| `tile_dataset_path` | `~/.geocode-web-single/tiles/datasets` | 取り込みで作る完成DB・完成直前DB |
| `tile_cache_path` | `~/.geocode-web-single/tiles/png` | PNG・公開直前ファイル・事前生成manifest |
| `tile_work_path` | `~/.geocode-web-single/tiles/work` | 取り込みのstaging DB・ジョブ作業領域 |

JSONにはホームを解決した絶対パスが保存される。独自の値にも絶対パスを指定し、相対パスや`~`の省略記法は使用しない。catalogにはディレクトリではなくDBファイルのパスを指定する。3つの保存ディレクトリは同じ場所や互いの配下へ置かず、catalogもこれらの中や同じ場所へ置かない。既定のように`tiles`直下へcatalogと各ディレクトリを並べる配置は利用できる。古いJSONの欠落・nullには既定値を補完し、既存の画像・DB等の設定値を保持する。`.env`への追記は不要。

たとえば、完成DBと作業領域をDドライブ、PNGをEドライブへ置く場合は次の項目を設定する。これはJSON全体ではなく追加・変更する項目の抜粋。

```json
{
  "tile_catalog_database_path": "D:/GeoCode/tiles/catalog.sqlite",
  "tile_dataset_path": "D:/GeoCode/tiles/datasets",
  "tile_cache_path": "E:/GeoCode/tiles/png",
  "tile_work_path": "D:/GeoCode/tiles/work"
}
```

変更はアプリまたは`-s`サーバーの再起動で反映する。既存ファイルの自動移動・自動削除は行わない。保存先の消失や容量不足があっても、別の既定ディスクへ黙って保存し直さない。

PNGだけを別ディスクへ置く場合は、`tile_cache_path`だけを変更する。catalog・完成DB・作業領域の場所は変わらない。catalogの既定値は他の保存先設定から派生しない。

### 管理DBと完成DBの違い

catalogはデータセット登録、描画世代、ジョブ履歴を持つ更新可能なSQLiteで、完成DB内の地物・DEMやPNGは保持しない。本体DBに`local_tile_datasets`・`local_tile_render_profiles`・`local_tile_jobs`は作らず、背景設定・共有・認証は本体DBに残る。catalogのschemaは`src/local_tiles/migrations/`で独立して版管理し、本体の`migrations/`へタイル用SQLを追加しない。標準地図への拡張でもcatalogのschema1と既存SQLのチェックサムを維持する。

起動時にcatalog固有の`application_id`とschemaを検査し、無関係なSQLite・破損DB・未対応の将来版をそのままcatalogとして初期化しない。本体DBや完成DBと同じ実ファイルを指定する構成も拒否する。catalogは本体DBとの対応を記録し、別の本体DBから同じcatalogを共用することはできない。

CLIでwriter操作を開始するか、配信で生成を開始する段階で、必要な保存先とプロセス間lockを確認する。同じ保存先に書き込む生成runtimeは単一プロセスが所有する。別のアプリが所有中なら新規生成・取り込み・整理を開始できない。保存済みPNGの読み取り配信と既存の外部タイル機能は別に利用できる。

### 一時ファイルと必要な空き容量

PNGの公開直前ファイルはPNG保存先と同じファイルシステムに作る。取り込みのstaging DBは作業領域へ置くが、完成直前の`data.building.sqlite`は完成DBの隣へ作る。したがって、DB側ディスクにも完成直前DB・journal分の空き容量が必要になる。

完成DBはhard linkによる上書きなしの公開を使うため、DB保存先は対応するファイルシステムが必要。完成DBを作る保存先を指定する前に対応状況を確認する。外部参照の完成DBは読み取り専用でも利用できる。

4項目で管理するのはアプリが明示的に作るファイル。catalogはWALを使用するため、catalogのディスクにもDB本体・WAL等の空き容量と書き込み権限が必要。SQLiteが検索・ソート中に内部作成する一時ファイルはOS標準の一時領域を使用する。OS一時領域にも容量と書き込み権限が必要となる。プロセス全体の`TEMP`やSQLiteのグローバル一時保存先を変更しない。

PNG容量は`local-tiles cache scan`で明示的に調べる。状態照会や監視では再走査しない。時間・件数の上限に達した場合は、確認できた容量を「少なくとも」として表示する。全容量が必要な場合は設定したPNGフォルダの容量をOSでも確認する。自動容量制限・自動LRU削除は行わない。

### 保存先を移設する

1. 取り込み・事前生成を終了または取り消し、実処理が停止したことを確認してアプリを正常終了する。同じ保存先を使う通常起動・`-s`の全プロセスを停止する。
2. 設定JSONとcatalogをバックアップし、catalog・完成DB・PNG・作業領域のうち移したい内容を移設する。完成DB・PNG・作業領域はディレクトリ構造を保つ。catalogのコピー方法は後述のバックアップ手順に従う。
3. JSONの対応する項目を新しい絶対パスへ変更し、アプリを起動する。
4. CLIの`config show`・`datasets list`・`url`と、地図からの既存PNG利用を確認する。

本体が取り込んだDBは設定rootからの相対位置で管理するため、同じ構造で移す。外部参照で登録したDBの絶対パスは`tile_dataset_path`変更では移らない。外部参照DBを移した場合は、同じ内容のDBを`datasets register`で新しい絶対パスを登録し直すと、既存のデータセット・キャッシュ識別を維持して参照先と表示名を更新できる。

catalogだけを移す場合は、同じ本体DBを使い、`tile_catalog_database_path`をコピー先へ変更する。空のcatalogへ切り替えると以前の登録・履歴は引き継がれない。移設のために管理テーブルや識別値を直接編集しない。

本体DBとの対応には正規化したパスと実ファイルの識別を使う。本体DBの移動・置換・復元で対応が変わった場合は、自動で付け替えず利用を拒否する。この手順は本体DBを変更しないcatalog等の移設を対象とし、本体DBの移設・復元ではcatalogとの対応も別途確認する。対応変更用CLIは提供していない。

PNGだけを空の新しい保存先へ切り替えた場合、現在の描画版のタイルは必要に応じて再生成される。旧PNGは元の場所に残る。旧描画版の保存PNGを使い続けたい場合は、その世代のディレクトリも移す。

## 世代の保持と共有への影響

配信URLは`/local-tiles/<dataset_id>/<render_id>/{z}/{x}/{y}.png`となる。データセット・描画世代を含め、異なるDBや描画版のPNGを混在させない。既存の外部プロキシ`/tile/{z}/{x}/{y}.png`とRedisキャッシュはそのまま維持する。

共有スナップショットは背景URLを保持するが、PNG自体は保存しない。共有を表示し続けるには、参照するデータセットと世代を保持する必要がある。描画契約が変わっても、保持済みの旧版PNGは配信できる。一方、互換性のない旧版URLで未生成のタイルは現在の描画で補わず410となる。新しい描画版を通常地図で使う場合は、背景地図へ追加して選び直す。同じ描画契約内のアプリ更新では、既存の背景・共有・PNGをそのまま利用できる。

`datasets retire`は、背景設定・保存済み共有から参照されている間は拒否する。不要な背景参照を変更し、共有参照を解除した後に行う。利用停止後のURLは410となり、同じデータセットの再登録による復活はできない。完成DB・元PBFは削除しない。

`cache cleanup`は、利用停止済みデータセット・描画世代で、参照も実行中ジョブもない場合だけ行える。指定世代のPNGと付属記録を削除する。完成DBや元PBFは対象外。

## 実行上限

次の設定もJSONの文字列値として指定し、再起動で反映する。値はHTTP性能保証ではなく、実際の地図とPCで調整するための上限。

| JSON項目 | 既定値 | 意味 |
| --- | --- | --- |
| `local_tile_workers` | `"2"` | 事前生成と共有する実描画数 |
| `local_tile_queue_capacity` | `"128"` | 待機する固有タイルjob数 |
| `local_tile_max_subscribers` | `"256"` | 待機要求数の上限 |
| `local_tile_background_queue_capacity` | `"4"` | 取り込み・事前生成の待機ジョブ数合計 |
| `local_tile_job_timeout_seconds` | `"120"` | queue待機を含むタイル生成jobの期限 |
| `local_tile_http_timeout_seconds` | `"60"` | 個々のHTTP要求の待機期限 |
| `local_tile_precompute_max_tiles` | `"1000000"` | 事前生成1ジョブの受付枚数上限 |

取り込みと事前生成の実行は各1ジョブまで。取り込み全体へタイル生成用120秒は適用しない。待機上限を超える要求は503、HTTP待機期限は504となる。1要求の離脱だけで他の要求が待つ共有生成を取り消さない。HTTP待機が終わっても、実処理の終了までは描画枠を保持する。

## バックアップと障害対応

取り込み失敗時は`jobs show --job ID --json`で`error`と`progress`を確認する。対応版では内部の原因と終了直前の診断も保存し、CLIの診断ログは標準エラーへ出す。以前の版で保存されなかった原因は、新版の照会だけでは復元できない。作業領域・完成直前DB・原資料を保持したまま調査し、原因が分かるまでは取り込みを繰り返さない。

### タイル専用データを破棄して作り直す

旧DB・PNG・履歴を再作成する場合は、次の順で行う。設定JSON・本体GIS DB・画像・元PBF・DEM・陸域資料は保持する。

1. 取り込み・事前生成を正常終了し、同じ保存先を使うGUI・`-s`の全プロセスを終了する。
2. 次の照会で、実際の4つの保存先を記録する。別の設定JSONを使っている場合は同じ`--config`を指定する。

   ```powershell
   & $exe local-tiles config show --json | ConvertFrom-Json |
     Select-Object tile_catalog_database_path, tile_dataset_path, tile_cache_path, tile_work_path |
     Format-List
   ```

3. 削除対象の絶対パスを確認する。入力資料・本体DB・画像・設定JSONがその配下に入っている構成では、先に保全対象を移して設定を整える。再解析ポイントの参照先や、別ディスクの配置も確認する。
4. タイル管理DBと対応する`-wal`・`-shm`、タイル完成DBディレクトリ、PNG・manifestディレクトリ、作業ディレクトリを破棄する。`.geocode-web-single`全体や本体GIS DBを一括削除しない。
5. `elevation inspect`で確認後、新しいrequest IDで標準地図を取り込み、`datasets prepare`、小範囲の事前生成、`background add`を実行する。空のcatalogは取り込み時に作成される。
6. GUIを起動して新しい背景を選ぶ。共通の背景設定に残る古い`/local-tiles/`背景も使う場合は、共通の編集画面で新しい有効なURLへ更新する。旧タイルURLを保存した共有は必要に応じて作り直す。外部背景や無関係な共有はそのまま使う。その後、再びCLIで書き込む場合はGUI・`-s`を終了する。

新しい取り込み識別でDBとPNGを作るため、失敗したジョブの作業DBへ追記する必要はない。保存先を変えずに新しい完成DBを追加する方法も利用できる。再作成によって、過去のジョブ履歴や旧タイルURLが復元されることはない。

### バックアップと復元

バックアップは、同じデータを使う通常起動・`-s`の全プロセスを正常終了してから、設定JSON、本体DB、catalog、保持する完成DBを一式として取る。データセット・描画世代・ジョブの登録情報はcatalogに含まれ、本体DBだけのバックアップでは復元できない。現在の版で再生成できるPNGは省略できるが、旧描画版の共有を維持する場合はそのPNGも保存する。事前生成の再開には対応するmanifestも必要。PBFは将来再取り込みする場合に別途保管する。

catalog等の更新可能なSQLiteでは、稼働中のDBファイルだけをコピーしない。SQLiteのbackup APIに対応したツールで一貫したsnapshotを作るか、全プロセスの正常終了とsidecarの状態を確認してコピーする。`-wal`・`-shm`・journalが残っている場合は、未反映の更新や復旧に必要な情報を含む可能性があるため、手動で削除してDBだけをコピーしない。停止した一式を保全し、SQLiteが整合性を保って読み出せる方法でバックアップする。catalogの移設後に古いWALや別のDBのsidecarを新しいDBへ混ぜない。

DBの復元は全プロセスを止め、本体DB・catalog・設定が対応する組合せで行う。本体DBの実ファイル識別が変わる復元はcatalogの対応検査で拒否される場合があり、自動的な再対応付けは行わない。

起動時は所有lockで実行元がなくなったジョブを確認し、中断として記録する。取り込みの残骸や元PBFを一括自動削除しない。調査後に手動で整理する場合も、使用中の完成DB・ジョブ領域と区別する。

| 表示・応答 | 確認する内容 |
| --- | --- |
| DBを利用できない | 保存先のドライブ・権限、外部参照DBの絶対パス、未完成DB・sidecarの有無 |
| 管理DBを利用できない | catalogの保存先・権限、専用schema・application_id、本体DBとの対応。別のDBで置き換えていないか |
| 503 | 別プロセスの所有、実行・待機上限、保存先の利用可否 |
| 504・期限終了 | 対象範囲と描画負荷。実処理の終了後、範囲・上限・期限を見直す |
| 409で停止・整理できない | 背景・保存済み共有の参照、実行中ジョブの有無 |
| 410 | 利用停止済み、または旧描画世代で未生成のタイル |
| 容量不足 | DB・PNG・作業ディスクとOS一時領域の空き容量 |

## オフラインで利用できる範囲

完成DB、実行ファイル、ローカル資材と設定があれば、元PBF・DEM・陸域入力なし・ネットワーク遮断下でもローカル背景を生成・表示できる。必要な共有URLも同じローカルサーバーから開く。ブラウザだけを切り離してアプリのローカルサーバーなしで動く方式ではない。

外部住所検索、外部背景、気象タイル、外部カメラ等は別の通信機能。オフライン利用時はローカル背景を選択し、それらを要求しない構成にする。ローカル生成の失敗時に外部タイルへ自動fallbackしない。タイル配信URLは匿名でも取得可能であり、`-s`等でネットワーク公開する場合は公開範囲に含まれる。

## 関連する実装と確認

[内部生成核](../src/tilegen/mod.rs)、[ローカル実行管理](../src/local_tiles/mod.rs)、[XYZ配信API](../src/handler/local_tiles.rs)、[本体CLI](../src/local_tiles/cli.rs)を参照する。

導入時は、小地域の完成DBまたは小PBFから始め、missから保存・次回hit、並行要求、取消後の正常要求、再起動、PNG別ドライブ、元PBF不在・ネットワーク遮断で確認する。PC・モバイル・共有・印刷で出典と同じ世代の画像を確認する。

標準地図の段階・受入条件は[地物・標高地形の拡張計画](plans/LOCAL_TILE_FEATURE_EXPANSION_PLAN.md)を参照する。人工地域の初期レビュー画像は`tests/fixtures/standard-render-golden/`に独立して保存し、旧道路の35画像を置き換えない。実装・検証の記録と、利用者による実アプリ・全国データの確認を区別する。
