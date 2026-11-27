# ローカル地図の管理画面・CLIとXYZ配信

GeoCode-Web-Single本体にOSM PBFの取り込み・地図PNGの生成・配信を組み込んでいる。管理操作は同じexeの`local-tiles`コマンドを使い、地図はPostgreSQL版と共通の背景地図設定から通常のXYZタイルURLとして利用する。別の生成バイナリや管理サーバーは不要。

正式対応はWindows 64bit。画像はXYZ・Web Mercator・256×256pxの不透明PNG、ズーム0〜22。取り込みの既定値は従来の道路専用形式。`--features standard-v2`では、道路・建物・土地被覆・水域・鉄道に加え、地名や主要なランドマーク名を収録する。OSM標準風の`osm-like-v1`スタイルを使い、同じ完成DBから道路・建物・文字・等高線・陰影の表示を選んだ描画世代を作成できる。DEMと陸域データは別途指定する。既存の道路形式と、文字を持たない`standard-v1`も継続利用できる。住所検索、3D建物、全店舗名や全建物名の網羅は対象外。

全国の名称付き地図を導入する具体的な手順は、[初回起動前からの手順書](JAPAN_LOCAL_TILES_SETUP.md)を参照する。[PowerShellスクリプト](../scripts/setup-japan-local-tiles.ps1)で全国PBF・分割WGS84陸域の取得、事前確認、取り込み、背景登録を実行できる。

## サーバを起動せず管理画面を開く

```powershell
& 'C:/GeoCode/geocode_web_single.exe' local-tiles gui
# 別の設定を使う場合
& 'C:/GeoCode/geocode_web_single.exe' local-tiles gui --config 'D:/GeoCode/geocode-web-single.env.json'
```

初回設定画面と同じTauriの専用ウィンドウで表示する。このモードでは通常アプリ・HTTPサーバ・タイル配信を起動しない。初期設定がない場合も、この画面で管理者情報を入力して設定と本体DBを準備できる。既存の設定・本体DBは上書きしない。

1. 「地図を取り込む」でPBFと表示名を選ぶ。通常は地名・ランドマーク付きの形式を使い、必要に応じて陸域Shapefileや標高フォルダー、等高線の収録を指定する。
2. 取り込み完了後、「データセット」で描画条件を準備する。既存の完成DBを登録することもできる。タイルURLをコピーするか、本体の背景地図へ登録する。
3. 「タイルを事前生成」で対象データセット・描画条件・範囲・ズームを指定し、予定枚数を確認してから開始する。
4. 処理を開始すると「処理状況」が開く。受付中・待機中・実行中の処理と取消の進捗をここで確認する。地図取り込みと道路網作成のバーは、選択した工程の実測時間をもとにした「全体 約○%」。PBFの走査量や処理した地物・区間を下段に表示する。事前生成は完了枚数／全枚数と新規・再利用枚数を表示する。
   残り時間は直近の速度と後続工程の時間配分からの目安。事前生成では新規描画と再利用を別々に計測する。受付直後や、長い検査などで見積もりを更新できない間は「残り時間を計算中」と表示する。GUIを開き直してもワーカーの最新記録から表示を復元する。
5. 終了した処理は「履歴」に新しい順に並ぶ。完了・失敗などの通知から「履歴を開く」を選ぶと、結果・診断・ログを確認できる。事前生成が失敗・取消・中断・期限終了となった場合は、履歴の「再開」から続行できる。

進捗の初期配分には、四国の道路網、香川の道路地図・標準地図、全国の標準地図の工程時間を使用する。標高を含む場合は事前検査で得た格子のセル数とPBF容量に応じて、標高・等高線の時間配分を調整する。同じ入力パス・形式・地形資料・取り込み設定で地図を再取り込みする場合は、直近32件のジョブに保存された成功レポートから配分を補正する。PBFの容量は各走査で処理し終えたブロックまでを示す。道路区間や地物の書き込みにも時間がかかるため、PBFを半分読んだ時点の全体進捗は50%と異なることがある。100%は検査・登録または公開が完了した時点で表示する。

管理画面では「面地物を構築できない場合」の既定値を「該当する面地物を除外する」とし、全国用PowerShellスクリプトと同じく、構築できない面全体を除外して残りの取り込みを続ける。停止させたい場合は「詳細設定」で「処理を停止する」を選ぶ。完了後は除外件数と診断を確認する。PBFの破損、保存先への書き込み失敗、取消などは全体を中断する。CLIで`--invalid-areas`を省略した場合の既定値は`error`のままとする。

生成処理は同じexeの独立した非表示ワーカーで動く。管理ウィンドウを閉じても、受け付けた処理は継続する。同じ設定で管理画面を開き直すと実行中の状態を確認でき、取消も可能。ワーカーは処理終了時に排他を解放して終了する。画面を閉じる操作と「取消」は別である。

PC終了・ワーカープロセスの強制終了からの継続は保証しない。異常停止した処理は中断として扱い、事前生成は履歴から再開できる。PBF取り込みの途中再開は従来どおり未対応。通常アプリ・サーバー・別CLIが生成を所有している間も照会できるが、新しい生成・登録は所有中の処理が終了してから行う。管理画面が実行中プロセスを停止したり所有権を奪ったりすることはない。

資料のダウンロードは下記手順のPowerShellスクリプトを使う。管理画面では取得済みのローカルファイルを指定する。

### 進捗表示の実測

Windows x64のリリース版で、初めて取り込む地域のジョブをTauriの「処理状況」で約0.45秒ごとに観測した。残り時間を出せた時点ごとに、ワーカーの推定秒数と実際の完了までの秒数の差を取り、その絶対値の中央値を示す。画面ではこの推定を秒または分単位に丸める。

| 処理 | 完了まで | 残り時間の誤差の中央値 |
| --- | ---: | ---: |
| 東北の道路網を作成（312 MB） | 2分1秒 | 7.9秒 |
| 愛媛の一部の標準地図を取り込み（10 MB） | 20.8秒 | 3.4秒 |
| 同じ標準地図に標高資料6枚と等高線を追加 | 27.5秒 | 3.4秒 |
| 同地域のタイルを事前生成（ズーム16、4,347枚） | 15.4秒 | 3.9秒 |

東北では開始から約60秒で全体約46%、残りの推定は66秒、実際は約61秒だった。初期配分の調整には四国の道路網（52.5秒）と香川の一部の地図を使い、東北と愛媛で別途検証した。標高の時間配分は愛媛のDEM10B 1枚で調整し、6枚をまとめた入力で確認した。香川・愛媛の地図用PBFは四国の原資料から範囲内のノードと全参照先が範囲内にある道路・地物を抽出し、ノードタグとリレーションは含めていない。

全国の標準地図は陸域を含む既存の成功記録を参照した。全3時間26分のうち、地物構築・陸域などが約2時間12分、最終検査・公開が約38分を占めた。全国の道路網の初期推定には以前の構築時間（約64分）を使用した。全国の進捗表示や残り時間は今回の実行では計測していない。[全国の道路網の実測記録](performance/local-routing-v1.json)

## 車・徒歩の経路を調べる

1. `local-tiles gui` の「経路」を開き、「道路網を作成する」で元の `.osm.pbf` と道路網の名前を指定する。1回の取り込みで普通乗用車と徒歩の両方を利用できる。タイル用の完成DBや背景登録は不要。
2. 作成中は「処理状況」で段階と件数を、終了後は「履歴」で結果を確認できる。管理画面を閉じてもワーカーは続行する。同じ名前で作り直すと、完成検査後に新しい道路網に切り替わる。途中で取り消した場合は従来の道路網を利用できる。
3. 「経路」で道路網と移動手段を選び、出発地・目的地を地図上で指定するか、緯度・経度を入力する。「経路を検索」で、道路に沿った経路線、距離、概算所要時間が表示される。指定点と道路上の発着点は地図と結果欄で確認できる。
4. 「背景地図」で登録済みの描画条件を選ぶと、事前生成したPNGを重ねて表示できる。未生成なら、現在の表示範囲を「タイルを事前生成」に渡せる。背景がなくても座標指定と経路検索は利用できる。
5. 通常地図でも利用する場合は「GeoCode-Webへの経路配信」を開き、HTTP配信を有効にして道路網を選ぶ。「このSingle版からの接続も許可する」の初期値はオンで、既定の許可先は `http://127.0.0.1:3000`。「配信設定を保存」を押してSingle本体を再起動し、管理画面の「OSRM設定」で車・徒歩の接続先を登録する。[通常地図の接続設定](OSRM.md#作成済みのローカル道路網を使う)

検索は端末内の道路網で行う。普通車は進行方向・アクセス・右左折規制、徒歩は徒歩の通行条件と方向指定を使う。所要時間は道路種別などから見積もった静的な値で、渋滞や現在時刻で変化しない。日時指定が必要な通行禁止は保守的に対象から外すため、時間帯によっては実際に通れる経路が除外される。

車・徒歩ともに、出発地と目的地それぞれの半径500 m以内で、選んだ移動手段が通れる最も近い道路を探す。距離と所要時間は、道路上の出発点から到着点までの値。範囲内に道路が見つからない場合と、道路網内で両地点がつながらない場合は、それぞれ理由を表示する。

道路網の保存先は、設定された `tile_dataset_path` 配下の `routing/<世代ID>/`。バックアップ時は `graph.sqlite` と `generation.json` を含むディレクトリ単位で保存する。「道路網の情報と出典」では、元PBFのSHA-256や道路区間数、規制の件数を確認できる。通常地図からこの道路網を使うには [ローカル道路網への接続手順](OSRM.md#作成済みのローカル道路網を使う) を参照する。

実データで性能を計測するには `cargo run --locked --release --example measure_local_routing -- <PBF> <既存の作業フォルダー> <出発緯度> <出発経度> <到着緯度> <到着経度>` を実行する。一時道路網の構築時間・完成サイズ・サンプリングした作業容量と、車・徒歩それぞれ5回の検索時間をJSONで出力する。作業フォルダー配下に作成した一時道路網は正常終了時に片付ける。

高松市中心部・四国・日本全国の道路網で、高松市内の同じ2地点を検索した。四国では高松駅付近から坂出駅付近までの検索も計測した。作業容量は全国で観測できた値を掲載している。計測環境、構築時間、完成サイズ、車・徒歩の初回・中央値・最大検索時間は[ローカル経路の実測記録](performance/local-routing-v1.json)を参照。

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

輪郭の内部が交差せず、面の内部を分断しない点接触は取り込める。同じ外周に属する穴同士が辺を共有する場合は、その共有辺を除いて穴を統合する。接点は縮約形状でも保持する。外周を含む共有辺、自己交差、roleの矛盾、欠損memberの自動補修は行わない。この対応を既存の地図に反映するにはPBFを再取り込みする。新しい取り込み契約により別のデータセットとなり、既存の完成DBとタイルはそのまま利用できる。

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

起動時にcatalog固有の`application_id`とschemaを検査し、無関係なSQLite・破損DB・未対応の将来版をそのままcatalogとして初期化しない。本体DBや完成DBと同じ実ファイルを指定する構成も拒否する。本体DBとcatalogは独立して選択できる。通常起動では、選択したそれぞれのDBの形式と利用可否を確認する。

CLIでwriter操作を開始するか、配信で生成を開始する段階で、必要な保存先とプロセス間lockを確認する。同じ保存先に書き込む生成runtimeは単一プロセスが所有する。別のアプリが所有中なら新規生成・取り込み・整理を開始できない。保存済みPNGの読み取り配信と既存の外部タイル機能は別に利用できる。

### 一時ファイルと必要な空き容量

PNGの公開直前ファイルはPNG保存先と同じファイルシステムに作る。取り込みのstaging DBは作業領域へ置くが、完成直前の`data.building.sqlite`は完成DBの隣へ作る。したがって、DB側ディスクにも完成直前DB・journal分の空き容量が必要になる。

完成DBとPNGは、保存先と同じファイルシステムで構築を終えてから、既存ファイルを上書きしない方法で公開する。Windowsではハードリンクを必要としない。外部参照の完成DBは読み取り専用でも利用できる。

4項目で管理するのはアプリが明示的に作るファイル。catalogはWALを使用するため、catalogのディスクにもDB本体・WAL等の空き容量と書き込み権限が必要。SQLiteが検索・ソート中に内部作成する一時ファイルはOS標準の一時領域を使用する。OS一時領域にも容量と書き込み権限が必要となる。プロセス全体の`TEMP`やSQLiteのグローバル一時保存先を変更しない。

PNG容量は`local-tiles cache scan`で明示的に調べる。状態照会や監視では再走査しない。時間・件数の上限に達した場合は、確認できた容量を「少なくとも」として表示する。全容量が必要な場合は設定したPNGフォルダの容量をOSでも確認する。自動容量制限・自動LRU削除は行わない。

### データの保存先を変更する

1. 通常アプリ・サーバー・生成処理を終了する。移動する場合は、エクスプローラーで本体DBや `tiles` フォルダーを移動する。既に用意してある別の本体DBやタイル一式もそのまま選択できる。
2. `local-tiles gui` の「データの保存先」タブを開く。本体だけ切り替える場合は使いたい本体DBを、地図だけ切り替える場合は `catalog.sqlite` を含む `tiles` フォルダーを選ぶ。標準構成では `datasets`（道路網を含む）、`png`、`work` もこのフォルダーの下に切り替わる。
3. 「この保存先を使う」を押す。選んだDBの形式と地図の参照先が確認できると、設定JSONが更新される。保存先が分かれている場合は個別に指定できる。完成DBを個別に移した場合は、該当の地図の新しい `data.sqlite` を指定する。

本体DBの内容が以前と異なる場合も同じ操作で切り替えられる。ユーザー・共有・背景地図設定には選んだ本体DBの内容、地図登録・描画世代・ジョブ履歴には選んだカタログの内容が使われる。同じ場所での本体DBの差し替えは、停止中にファイルを差し替えて次回起動するだけでよい。旧設定の `tile_database_replacement` は通常の利用条件から外れ、保存先を適用すると設定JSONから取り除かれる。

以前の版で作成した本体DBを選び、更新を案内された場合は、本体アプリを一度起動してDBを更新する。切り替え先に経路配信用の道路網がない場合は、「経路」タブでその保存先にある道路網を選ぶ。

外付けドライブやSDカードを外しているときは、接続し直すか、表示された保存先を選び直す。ドライブ文字が変わった場合も `tiles` の選択でまとめて更新できる。未接続の保存先は設定に残る。初めて空のタイル管理DBを作成する操作は、既存のデータを選ぶ操作と区別して表示される。中断した変更がある場合は、同じ設定JSONで「データの保存先」を開いて再開する。

### 旧版との互換用にカタログの対応付けを更新する

以下は、旧版のカタログに記録された本体DBの対応情報を、専用CLIで厳密に照合・更新する場合の手順。現在のGUI・サーバー・生成CLIで保存先を変更する通常の手順は、上記の「データの保存先を変更する」を使う。

更新は次のいずれかで同一性を確認できる場合だけ許可する。

- 同じ実ファイルを同一ボリューム内で移動し、ファイル識別子が維持されている場合。
- catalogに登録された元の実ファイル、または同じcatalogに対して差し替えを許可した元の場所の本体DBが残っており、移設先の全テーブル・全行と照合できる場合。
- 移設前の正しい対応付けで作成した、改ざん検証付きの移設記録があり、その記録と移設先の内容が一致する場合。

元ファイルを使う場合は、計画作成から適用完了まで元ファイルも保全する。元ファイルが残っている場合は、適用時に元・先の両方を保護して再照合し、旧設定で起動したアプリが元DBを書き込んでいる場合も拒否する。

ファイル識別子の異なる通常のバックアップコピーだけでは、catalogとの対応を証明できない。元ファイルも事前記録もない場合は自動更新できない。移設記録を使うコピーでは、記録後に本体DB・catalogの内容を変更しない。通常起動によるmigrationやログイン後の更新等で内容が変わった場合も照合は失敗し、既存データを変更せず停止する。検査を省略する強制オプションはない。

PowerShell補助スクリプトの例（各パスは実環境へ置き換える。移設先は、この作業を実行するPC上のローカルディスクを使う）：

```powershell
$exe = 'C:/GeoCode/geocode_web_single.exe'
$config = 'C:/Users/yourname/.geocode-web-single/geocode-web-single.env.json'
$helper = './scripts/rebind-local-tile-catalog.ps1'

# 1. 現在の対応を読み取り専用で診断
& $helper -Executable $exe -ConfigFile $config -Mode Inspect

# 2. 元の実ファイルが残っている場合：全内容を照合して計画を保存
& $helper -Executable $exe -ConfigFile $config -Mode Plan `
  -OriginalDatabase 'C:/original/geocode-web.sqlite' `
  -PlanFile 'C:/backup/catalog-rebind-plan.json'

# 3. 表示された旧・新の本体DBを確認して適用（計画は15分間有効）
& $helper -Executable $exe -ConfigFile $config -Mode Apply `
  -PlanFile 'C:/backup/catalog-rebind-plan.json'
```

同じ実ファイルの移動で識別子が維持されていれば、`Plan`の`-OriginalDatabase`と`-ProofFile`は省略できる。

これから本体DBをコピーする場合は、移設前の正しい設定で次を実行する。保存先の親フォルダーは先に用意する。既存ファイルは上書きしない。記録は7日間有効で、秘密鍵自体を含めない。

```powershell
# 移設前：アプリ等を終了し、正しく対応している本体DBとcatalogから記録を作る
& $helper -Executable $exe -ConfigFile $config -Mode Prepare `
  -ProofFile 'C:/backup/catalog-relocation-proof.json'

# 本体DB・catalog等を整合した一式として移し、同じ設定JSONの保存先を修正した後
& $helper -Executable $exe -ConfigFile $config -Mode Plan `
  -ProofFile 'C:/backup/catalog-relocation-proof.json' `
  -PlanFile 'C:/backup/catalog-rebind-plan-new.json'
& $helper -Executable $exe -ConfigFile $config -Mode Apply `
  -PlanFile 'C:/backup/catalog-rebind-plan-new.json'
```

直接CLIを使う場合のコマンドは`local-tiles catalog rebind inspect`、`prepare --output ABSOLUTE_JSON`、`plan [--source-database ORIGINAL_DB | --proof PROOF_JSON]`、`apply --plan PLAN_JSON`。共通で`--config ABSOLUTE_JSON --json`を指定できる。`plan`のJSONはUTF-8で保存する。補助スクリプトはWindows PowerShellでもUTF-8で保存し、既存の計画ファイルを上書きしない。

補助スクリプトが組織等の実行ポリシーで禁止されている場合は、ポリシーを変更せず直接CLIを使用する。

適用直前に設定・DBの識別子・全内容・稼働状況を再検査し、catalogの所有者ロックとSQLiteトランザクションを使う。catalogの隣の`catalog-relocation-UUID`へ、整合した`catalog.before.sqlite`と署名付き`receipt.json`を保存・照合してから、`tile_catalog_binding`の対応先2項目だけを更新する。本体DB・完成DB・PNG・描画世代・ジョブ履歴は更新しない。CLIの進捗は標準エラーで確認する。

適用前の中断では対応付けを確定せず、検証済みの中断記録が揃っていれば同じ計画で再試行できる。バックアップ作成途中等で記録が不完全な場合は、残ったファイルを保全して新しい計画を作る。適用済みの計画を再実行しても二重更新せず、記録と実際の対応先を確認して適用済みと返す。既存のバックアップを上書きしたり、古いバックアップを自動で現在のcatalogへ戻したりしない。

CLIの対応付け更新では外部登録した完成DBの絶対パスを保持する。必要な場合は対応付けの更新後に`datasets register`で参照先を更新する。完了後は`datasets list`・`jobs list`・既存URL・PNG利用・事前生成の再開を確認して通常運用へ戻る。

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
| `local_tile_workers` | `"4"` | 事前生成と共有する実描画数 |
| `local_tile_queue_capacity` | `"128"` | 待機する固有タイルjob数 |
| `local_tile_max_subscribers` | `"256"` | 待機要求数の上限 |
| `local_tile_background_queue_capacity` | `"4"` | 取り込み・事前生成の待機ジョブ数合計 |
| `local_tile_job_timeout_seconds` | `"120"` | queue待機を含むタイル生成jobの期限 |
| `local_tile_http_timeout_seconds` | `"60"` | 個々のHTTP要求の待機期限 |
| `local_tile_precompute_max_tiles` | `"1000000"` | 事前生成1ジョブの受付枚数上限 |

取り込みと事前生成の実行は各1ジョブまで。取り込み全体へタイル生成用120秒は適用しない。待機上限を超える要求は503、HTTP待機期限は504となる。1要求の離脱だけで他の要求が待つ共有生成を取り消さない。HTTP待機が終わっても、実処理の終了までは描画枠を保持する。

事前生成は1ジョブ内で複数タイルを並列に処理する。同時に要求する枚数は`local_tile_workers`・`local_tile_queue_capacity`・`local_tile_max_subscribers`の最小値までとし、既定は4枚。完了した枠へ次のタイルを補充し、全対象の要求を一括でメモリへ展開しない。GUIとCLIは同じ処理を使い、進捗は完了順に集計する。並列数は描画世代に含まれず、同じDB・描画条件なら同じPNGとURLを使う。

取消・失敗時は新しい投入を停止する。自分だけが待つ未開始タイルはキューから回収し、稼働中の描画は実終了を待ってから事前生成枠を解放する。HTTP等が同じタイルを待つ場合は、その生成を継続する。最終進捗には回収中に成功した枚数も反映する。HTTPの優先は待機キュー内の順序であり、実行中の描画を中断するものではない。並列数を増やすとCPU・DB読み取り・メモリの使用量も増えるため、まず既定4で利用し、実際の地図とPCで調整する。資源の少ないPCでは1〜2へ下げられる。

新規の初回設定と、`local_tile_workers`が欠落したJSONの補完では4を使う。既存JSONに明示された値は維持するため、以前の既定値2を保存している場合は、GUI・サーバー・生成CLIを正常終了してから、使用中の設定JSONの`"local_tile_workers": "2"`を`"local_tile_workers": "4"`へ変更し、再起動する。独自の設定JSONを`--config`で指定している場合は、そのファイルを変更する。

2026-11-17の[全国DBによる並列数比較](performance/local-tile-cpu-scaling-20261117.json)では、Core i5-13500（20論理CPU）・約32GBメモリ・NVMe SSDで、都市部144枚・広域64枚・沿岸部64枚を、空のPNG保存先と実CLIで各3回生成した。OSのファイルキャッシュを温め、実行順を交替した結果は次のとおり。時間は3範囲の合計の中央値、CPU使用率は検証用プロセスのCPU時間から算出したPC全体に対する割合。

| 並列数 | 合計時間 | CPU使用率 | 最大メモリ（RSS） |
| --- | ---: | ---: | ---: |
| 4 | 66.4秒 | 15.5% | 175MiB |
| 8 | 84.2秒 | 32.4% | 273MiB |
| 12 | 104.7秒 | 45.7% | 380MiB |
| 16 | 122.6秒 | 59.0% | 482MiB |
| 20 | 148.1秒 | 73.5% | 565MiB |

この条件で、比較した単一プロセスの4〜20並列では4が最速だった。1・2並列や全国全タイルの最適値は今回測定していない。12並列以上では1枚60秒を超える例もあり、CPU使用率を上げる目的だけで並列数を増やさない。時間は地物取得・描画の工程に集中し、同じ総16並列を別々の検証用保存先で4プロセス×4へ分ける追加試験では、合計の中央値が約48.0秒に短縮した。単一プロセス内の共有処理の競合が疑われるが、SQL・メモリ確保等の個別の寄与は未分離。実運用の同じcatalogを複数プロセスで同時所有する方法ではない。

新規生成は計72ジョブ・4,896枚が成功し、同じ座標のPNGはすべて一致した。旧版の参照56枚と元DB全体のSHA256も一致した。一方、追加の再開検証では、キャッシュ再利用15件中6件（12並列1件、16並列2件、20並列3件）と、20並列の取消後の再開1件で、管理DBの接続待ちタイムアウトが発生した。この問題は未修正であり、高並列で機能上の問題がないとは判定していない。追加確認20項目は成功13・失敗7・未実施0。二重writerの拒否・取消・枚数上限は成功し、生成認定・期限・所有権・実設定は変更していない。HTTP・GUI操作と`cargo test`は今回の計測対象に含めていない。

全国データの広域描画では、表示対象の地物種別を既存の索引から先に絞り、範囲内の地物だけ本体行を参照する。面地物は描画順に1地物ずつ縮約形状を優先して読み、道路の外縁・内側に使う同じ形状はlayer内で最大8MiB・32,768件まで再利用する。被覆・交点行・丸端の作業領域も再利用し、線の各辺が交差する標本行だけを処理する。単一形状のサイズ・点数、実際の描画演算量、取消・期限の検査は維持する。候補件数や合計形状量が多い広域タイルでも、地物を件数で間引かずに描画する。

## バックアップと障害対応

取り込み失敗時は`jobs show --job ID --json`で`error`と`progress`を確認する。対応版では内部の原因と終了直前の診断も保存し、CLIの診断ログは標準エラーへ出す。以前の版で保存されなかった原因は、新版の照会だけでは復元できない。作業領域・完成直前DB・原資料を保持したまま調査し、原因が分かるまでは取り込みを繰り返さない。

### 同じ広域タイルが繰り返し500になる場合

`ローカル地図の処理に失敗しました。CLIの状態表示またはログを確認してください。`は内部エラーのHTTP 500であり、期限超過の504とは別の応答。元原因はログの`Local tile render failed`または`Local tile operation failed`に出る。描画失敗は恒久的なキャッシュにせず、次のアクセスで再試行する。

旧版では、全国データの低ズームで候補地物の一括取得や空の走査行の累計処理が上限に達し、同じタイルが毎回失敗する場合がある。この場合は、処理を正常終了してGUI・`-s`・生成CLIを終了し、広域描画の修正を含む生成認定済みexeへ更新する。正常に取り込み済みの完成DBをそのまま使用でき、PBFの再取得・再取り込みは不要。この修正では描画結果と世代識別を維持するため、同じ背景URL・保存済みPNGを使用し、未生成タイルを再度開けばよい。

2026-11-15の[速度改善後の全国DB検証](performance/local-tile-nationwide-speed-20261115.json)では、ズーム0〜22と20地域を含む同じ完成DB・抽出132枚を、通常地図のSDK・2worker・1枚60秒の条件で新規生成し、全132枚が60秒未満で成功した。最長は`10/909/403`の約22.50秒で、前回の全132枚とPNGのSHA256が一致した。元DBのサイズ・更新時刻、dataset ID・render IDも維持している。[初回122枚成功・10枚失敗の検証](performance/local-tile-nationwide-check-20261114.json)と、[全件成功したが3枚が60秒を超えた前回検証](performance/local-tile-nationwide-fixed-20261114.json)も履歴として保持する。

2026-11-16の[事前生成の並列化検証](performance/local-tile-precompute-parallel-20261116.json)では、同じ全国DBの連続56枚を実CLIで生成し、旧版と1・2・4並列を順序交替で2反復比較した。2反復目の合計は旧版33.16秒、既定2並列26.43秒、4並列24.52秒で、全56枚×8組のPNGが一致し、再開24件も全PNGを再利用した。別途、同じ132枚の最終SDK回帰も全件成功・PNG一致・最長約23.24秒となった。初回はSDKの1枚が60秒で期限超過し、旧版CLIでも同じタイルの初回に約106秒を要したため、その失敗と反復時の結果も記録している。時間はキャッシュ状態等で変動する観測値であり、HTTPの待機時間を保証するものではない。

| 以前60秒を超えたタイル | 前回のSDK生成時間 | 今回のSDK生成時間 |
| --- | ---: | ---: |
| `6/56/25` | 94.44秒 | 16.05秒 |
| `7/110/51` | 79.27秒 | 10.26秒 |
| `9/454/201` | 61.11秒 | 13.48秒 |

今回の計測は実行サンドボックス外で行い、ビルド・回帰テストと重ねていない。SDKの検索・描画・PNGエンコードを含み、HTTPのキュー待機・初回セッション構築・PNG保存は含まない。HTTPや全国全PNGの総当たり検査は行っておらず、時間はキャッシュ状態・同時処理・PCの負荷に左右される観測値である。HTTPの待機期限となる場合は、必要な範囲を事前生成するか、実測に応じて`local_tile_http_timeout_seconds`を調整して再起動する。最後の待機要求が終了すると共有生成も取り消されるため、待機期限後に必ずPNGが完成するとは限らない。

更新後も500が続く場合は、失敗するURLのdataset ID・render ID・z/x/yと詳細ログを記録する。ログが候補・形状・演算量の上限を示す場合と、容量不足・アクセス拒否・保存先の消失等を示す場合で対処が異なる。500を待機時間の設定変更だけで解決しようとせず、元原因を確認する。

サーバーのログで確認する場合は、GUIと既存の`-s`を正常終了し、同じWindowsユーザーで次を実行する。起動後、ブラウザーから失敗する`/local-tiles/...png`を`http://127.0.0.1:3000`に対して開く。このログはstdoutとstderrをまとめた診断用テキストであり、JSONとして解析しない。

```powershell
& $exe -s '127.0.0.1:3000' 2>&1 |
  Tee-Object -FilePath './local-tiles-server.log'

# 再現後にCtrl+Cで終了してから、別のコマンドとして実行
Select-String -Path './local-tiles-server.log' `
  -Pattern 'Local tile render failed|Local tile operation failed' -Context 1,5
```

CLIの事前生成で確認する場合は、GUI・`-s`を終了し、対象の`$id`・`$renderId`・`$zoom`と、そのタイル内に収まる小範囲の`$bbox`を指定する。先に`precompute plan`で1枚になることを確認する。JSONはstdout、内部原因はstderrへ出るため、次のように別々に保存する。設定JSONが別の場所にある場合は、同じ`--config`も付ける。

```powershell
$job = & $exe local-tiles precompute run --dataset $id --render $renderId `
  --bbox $bbox --min-zoom $zoom --max-zoom $zoom --max-tiles 1 `
  --json 2> './local-tiles-render.stderr.log' | ConvertFrom-Json
$job | ConvertTo-Json -Depth 20 | Set-Content -Path './local-tiles-render.result.json' -Encoding utf8
```

事前生成の`jobs show`に保存される`error`は一般化された文言の場合があるため、詳細な原因はstderrログも確認する。JSONを解析するパイプへ`2>&1`を混ぜない。

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
4. タイル管理DBと同じ名前で始まる付随ファイル（`-wal`・`-shm`・`.owner.lock` など）、タイル完成DBディレクトリ、PNG・manifestディレクトリ、作業ディレクトリを、停止した状態で管理DBと一緒に退避する。再作成にはこれらが残っていない保存先を使う。
5. 「データの保存先」で新しいタイル管理DBを作成する。続いて `elevation inspect` で確認し、新しいrequest IDで標準地図を取り込み、`datasets prepare`、小範囲の事前生成、`background add` を実行する。
6. GUIを起動して新しい背景を選ぶ。共通の背景設定に残る古い`/local-tiles/`背景も使う場合は、共通の編集画面で新しい有効なURLへ更新する。旧タイルURLを保存した共有は必要に応じて作り直す。外部背景や無関係な共有はそのまま使う。その後、再びCLIで書き込む場合はGUI・`-s`を終了する。

新しい取り込み識別でDBとPNGを作るため、失敗したジョブの作業DBへ追記する必要はない。保存先を変えずに新しい完成DBを追加する方法も利用できる。再作成によって、過去のジョブ履歴や旧タイルURLが復元されることはない。

### バックアップと復元

バックアップは、同じデータを使う通常起動・`-s`の全プロセスを正常終了してから、設定JSON、本体DB、catalog、保持する完成DBを一式として取る。データセット・描画世代・ジョブの登録情報はcatalogに含まれ、本体DBだけのバックアップでは復元できない。現在の版で再生成できるPNGは省略できるが、旧描画版の共有を維持する場合はそのPNGも保存する。事前生成の再開には対応するmanifestも必要。PBFは将来再取り込みする場合に別途保管する。

catalog等の更新可能なSQLiteでは、稼働中のDBファイルだけをコピーしない。SQLiteのbackup APIに対応したツールで一貫したsnapshotを作るか、全プロセスの正常終了とsidecarの状態を確認してコピーする。`-wal`・`-shm`・journalが残っている場合は、未反映の更新や復旧に必要な情報を含む可能性があるため、手動で削除してDBだけをコピーしない。停止した一式を保全し、SQLiteが整合性を保って読み出せる方法でバックアップする。catalogの移設後に古いWALや別のDBのsidecarを新しいDBへ混ぜない。

DBの復元は全プロセスを止めて行う。同じ場所への復元はそのまま起動できる。保存先が変わる場合は「データの保存先」で使いたい本体DB・タイル一式を選び直す。

起動時は所有lockで実行元がなくなったジョブを確認し、中断として記録する。取り込みの残骸や元PBFを一括自動削除しない。調査後に手動で整理する場合も、使用中の完成DB・ジョブ領域と区別する。

| 表示・応答 | 確認する内容 |
| --- | --- |
| DBを利用できない | 保存先のドライブ・権限、外部参照DBの絶対パス、未完成DB・sidecarの有無 |
| 管理DBを利用できない | ドライブの接続、catalogの保存先・権限、専用schema・application_id。表示された保存先を「データの保存先」で確認する |
| 500・ローカル地図の処理に失敗 | 詳細ログの元原因を確認する。旧版の広域描画上限は修正済みexeへ更新し、正常な完成DBと同じ背景URLを再利用する |
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
