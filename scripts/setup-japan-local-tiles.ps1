#Requires -Version 7.0

<#
.SYNOPSIS
全国の地名・ランドマーク名付きローカル地図を準備する。
.DESCRIPTION
Download: 全国PBFと分割WGS84陸域を新しい入力フォルダーへ取得する。
Check: 入力、生成認定、初回セットアップ済みDB、owner、任意のDEMを検査する。
Import: 検査後、standard-v2で取り込み、日本語名称付き背景を登録する。
Publish: 既存DatasetIdから背景を登録する。取り込み後の復旧にも使用できる。
初回GUIセットアップと終了を先に行うこと。詳しくはdocs/JAPAN_LOCAL_TILES_SETUP.md。
.EXAMPLE
./setup-japan-local-tiles.ps1 -Action Download -DataDirectory D:/GeoCode-LocalTiles
.EXAMPLE
./setup-japan-local-tiles.ps1 -Action Import -ExePath C:/GeoCode/geocode_web_single.exe -DataDirectory D:/GeoCode-LocalTiles
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidateSet('Download', 'Check', 'Import', 'Publish')]
    [string]$Action,
    [string]$ExePath,
    [string]$DataDirectory = (Join-Path ([Environment]::GetFolderPath('UserProfile')) 'GeoCode-LocalTiles'),
    [string]$ConfigPath = (Join-Path ([Environment]::GetFolderPath('UserProfile')) '.geocode-web-single/geocode-web-single.env.json'),
    [string]$PbfPath,
    [string]$LandmaskPath,
    [string]$ElevationInput,
    [ValidateSet('strict', 'allow-jgd2000-2011')]
    [string]$ElevationDatumPolicy = 'strict',
    [ValidateNotNullOrEmpty()]
    [string]$Name = '全国・名称付き',
    [string]$DatasetId,
    [switch]$Terrain
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
# native stderrは進捗として端末へ出す。stdoutのJSONと混ぜない。
$PSNativeCommandUseErrorActionPreference = $false
$utf8 = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8

function Get-AbsolutePath([string]$Path) {
    return $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Path)
}

function Require-File([string]$Path, [string]$Description) {
    if ([string]::IsNullOrWhiteSpace($Path) -or -not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "$Description が見つかりません: $Path"
    }
    return (Get-Item -LiteralPath $Path).FullName
}

function Save-Json([string]$Path, $Value) {
    # JSONの更新中に古いreceiptを壊さない。同じディレクトリへ一旦保存する。
    $temporary = "$Path.$([guid]::NewGuid().ToString('N')).tmp"
    [IO.File]::WriteAllText($temporary, ($Value | ConvertTo-Json -Depth 50), $utf8)
    [IO.File]::Move($temporary, $Path, $true)
}

function Get-Property($Value, [string]$PropertyName) {
    if ($null -ne $Value -and $null -ne $Value.PSObject.Properties[$PropertyName]) {
        return $Value.$PropertyName
    }
    return $null
}

function Get-RemoteFile([string]$Uri, [string]$Destination) {
    Write-Host "取得: $Uri"
    # 大きな入力をメモリへ保持しない。失敗時は.partialを残し、既存入力を保持する。
    Invoke-WebRequest -Uri $Uri -OutFile "$Destination.partial" -MaximumRedirection 10
    Move-Item -LiteralPath "$Destination.partial" -Destination $Destination
}

$DataDirectory = Get-AbsolutePath $DataDirectory
$runKey = (Get-Date -Format 'yyyyMMddTHHmmss') + '-' + [guid]::NewGuid().ToString('N').Substring(0, 8)
$manifestPath = Join-Path $DataDirectory 'inputs.json'

if ($Action -eq 'Download') {
    $inputDirectory = Join-Path $DataDirectory "inputs/$runKey"
    New-Item -ItemType Directory -Path $inputDirectory -Force | Out-Null
    $downloadedPbf = Join-Path $inputDirectory 'japan-latest.osm.pbf'
    $checksumPath = "$downloadedPbf.md5"
    $landZip = Join-Path $inputDirectory 'land-polygons-split-4326.zip'
    Get-RemoteFile 'https://download.geofabrik.de/asia/japan-latest.osm.pbf.md5' $checksumPath
    $checksumText = [IO.File]::ReadAllText($checksumPath)
    if ($checksumText -notmatch '^\s*([0-9a-fA-F]{32})\s+') {
        throw "GeofabrikのMD5ファイル形式を確認してください: $checksumPath"
    }
    $expectedMd5 = $Matches[1].ToLowerInvariant()
    Get-RemoteFile 'https://download.geofabrik.de/asia/japan-latest.osm.pbf' $downloadedPbf
    $actualMd5 = (Get-FileHash -LiteralPath $downloadedPbf -Algorithm MD5).Hash.ToLowerInvariant()
    if ($actualMd5 -ne $expectedMd5) {
        throw 'PBFのMD5が一致しません。配布データの更新時刻と重なった場合もあります。Downloadを再実行してください。'
    }
    Get-RemoteFile 'https://osmdata.openstreetmap.de/download/land-polygons-split-4326.zip' $landZip
    $landDirectory = Join-Path $inputDirectory 'landmask'
    Write-Host "陸域ZIPを展開: $landDirectory"
    # ファイルからReadモードで展開し、大きなSHP全体をメモリへ保持しない。
    [IO.Compression.ZipFile]::ExtractToDirectory($landZip, $landDirectory)
    $shapes = @(Get-ChildItem -LiteralPath $landDirectory -Filter 'land_polygons.shp' -Recurse -File)
    if ($shapes.Count -ne 1) { throw '陸域ZIP内のland_polygons.shpを一意に特定できません。配布形式を確認してください。' }
    foreach ($extension in @('.prj', '.shx', '.dbf')) {
        $null = Require-File ([IO.Path]::ChangeExtension($shapes[0].FullName, $extension)) "陸域の$extension"
    }
    $inputs = [ordered]@{
        downloaded_at = [DateTimeOffset]::Now.ToString('o')
        PbfPath = $downloadedPbf
        PbfMd5 = $expectedMd5
        LandmaskPath = $shapes[0].FullName
        LandmaskZipSha256 = (Get-FileHash -LiteralPath $landZip -Algorithm SHA256).Hash.ToLowerInvariant()
        pbf_source = 'https://download.geofabrik.de/asia/japan.html'
        landmask_source = 'https://osmdata.openstreetmap.de/data/land-polygons.html'
    }
    Save-Json (Join-Path $inputDirectory 'inputs.json') $inputs
    Save-Json $manifestPath $inputs
    Write-Host "入力資料の準備が完了しました: $manifestPath"
    Write-Host '次はGUIの初回セットアップと正常終了後、同じDataDirectoryでCheck、Importを実行してください。'
    return
}

if ([string]::IsNullOrWhiteSpace($ExePath)) { throw 'Download以外では-ExePathを指定してください。' }
if ($Action -eq 'Publish' -and [string]::IsNullOrWhiteSpace($DatasetId)) { throw 'Publishでは-DatasetIdを指定してください。' }
$ExePath = Require-File $ExePath 'アプリのexe'
$ConfigPath = Get-AbsolutePath $ConfigPath
if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) {
    throw "設定JSONがありません。通常アプリを引数なしで起動し、初回セットアップを完了してから正常終了してください: $ConfigPath"
}
$logDirectory = Join-Path $DataDirectory "logs/run-$runKey"
New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
Write-Host "実行記録: $logDirectory"
$script:commandSequence = 0

function Invoke-TileCli([string]$Label, [string[]]$CommandArguments) {
    $script:commandSequence++
    $outputPath = Join-Path $logDirectory ('{0:D2}-{1}.json' -f $script:commandSequence, $Label)
    $cliArguments = @('local-tiles') + $CommandArguments + @('--config', $ConfigPath, '--json')
    Write-Host "実行: local-tiles $($CommandArguments -join ' ')"
    # GUIサブシステムのexeもパイプ経由で終了を待つ。stderrはリダイレクトしない。
    $raw = & $ExePath @cliArguments | Out-String
    $nativeExitCode = $LASTEXITCODE
    [IO.File]::WriteAllText($outputPath, $raw, $utf8)
    if ($nativeExitCode -ne 0) {
        throw "CLIが終了コード$nativeExitCode で停止しました。結果: $outputPath"
    }
    try { return $raw | ConvertFrom-Json -Depth 50 }
    catch { throw "CLIのJSONを読み取れません。exeの版とUTF-8出力を確認してください: $outputPath" }
}

$build = Invoke-TileCli 'build-info' @('build-info')
$generationVerified = Get-Property $build 'osm_generation_verified'
if ($generationVerified -isnot [bool] -or -not $generationVerified) {
    throw 'このexeでは名称付き地図の生成が認定されていません。build-infoのexecution.osmを確認してください。'
}
$config = Invoke-TileCli 'config' @('config', 'show')
$status = Invoke-TileCli 'status' @('status')
if ($status.owner_available -isnot [bool] -or -not $status.owner_available) {
    throw '生成ownerを別プロセスが使用中です。GUI・-sサーバー・他の生成CLIを正常終了してから再実行してください。'
}
$config | Format-List | Out-Host
Write-Host '入力・完成DB・作業領域・PNG・catalog・OS一時領域それぞれの空き容量を確認してください。'

if ($Action -ne 'Publish') {
    $inputs = $null
    if (([string]::IsNullOrWhiteSpace($PbfPath) -or [string]::IsNullOrWhiteSpace($LandmaskPath)) -and
        (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
        $inputs = Get-Content -LiteralPath $manifestPath -Raw -Encoding utf8 | ConvertFrom-Json
    }
    $useDownloadedPbf = [string]::IsNullOrWhiteSpace($PbfPath) -and $null -ne $inputs
    if ($useDownloadedPbf) { $PbfPath = $inputs.PbfPath }
    if ([string]::IsNullOrWhiteSpace($LandmaskPath) -and $null -ne $inputs) { $LandmaskPath = $inputs.LandmaskPath }
    $PbfPath = Require-File $PbfPath '全国PBF（先にDownloadまたは-PbfPathを指定）'
    $LandmaskPath = Require-File $LandmaskPath '分割WGS84陸域SHP（先にDownloadまたは-LandmaskPathを指定）'
    if ([IO.Path]::GetExtension($LandmaskPath) -ine '.shp') { throw '-LandmaskPathには.shpを指定してください。' }
    foreach ($extension in @('.prj', '.shx', '.dbf')) {
        $null = Require-File ([IO.Path]::ChangeExtension($LandmaskPath, $extension)) "陸域の$extension"
    }
    if ($useDownloadedPbf) {
        Write-Host 'ダウンロード済みPBFのMD5を確認しています。'
        if ((Get-FileHash -LiteralPath $PbfPath -Algorithm MD5).Hash -ine $inputs.PbfMd5) {
            throw 'PBFがダウンロード後に変更されています。inputs.jsonと入力資料の組合せを確認してください。'
        }
    }
    if (-not [string]::IsNullOrWhiteSpace($ElevationInput)) {
        $ElevationInput = Get-AbsolutePath $ElevationInput
        if (-not (Test-Path -LiteralPath $ElevationInput)) { throw "DEM入力がありません: $ElevationInput" }
        $elevation = Invoke-TileCli 'elevation-inspect' @('elevation', 'inspect', '--input', $ElevationInput,
            '--elevation-datum-policy', $ElevationDatumPolicy)
        if ($elevation.allowed -isnot [bool] -or -not $elevation.allowed) { throw 'DEM検査で受入不可となりました。' }
        $elevation | ConvertTo-Json -Depth 30 | Out-Host
    }
    elseif ($Terrain -or $ElevationDatumPolicy -ne 'strict') {
        throw '-Terrainや測地系混在の許可には-ElevationInputを指定してください。'
    }
    Get-Item -LiteralPath $PbfPath, $LandmaskPath | Select-Object FullName, Length | Format-Table -AutoSize | Out-Host
    Write-Host '陸域のCRS・幾何形状、PBFの全内容、DEM標高の本検査は取り込み時に実施します。'
    if ($Action -eq 'Check') {
        Write-Host '事前確認が完了しました。次は同じ条件で-Action Importを実行してください。'
        return
    }
    $requestId = [guid]::NewGuid().ToString()
    $importArguments = @('import', '--input', $PbfPath, '--name', $Name, '--features', 'standard-v2',
        '--landmask-input', $LandmaskPath, '--invalid-areas', 'skip-feature', '--missing-nodes', 'error',
        '--request-id', $requestId, '--contour-data', $(if ($ElevationInput) { 'on' } else { 'off' }))
    if ($ElevationInput) {
        $importArguments += @('--elevation-input', $ElevationInput, '--elevation-datum-policy', $ElevationDatumPolicy)
    }
    Save-Json (Join-Path $logDirectory 'import-request.json') ([ordered]@{
        request_id = $requestId; exe = $ExePath; config = $ConfigPath; arguments = $importArguments
    })
    $job = Invoke-TileCli 'import' $importArguments
    if ($job.state -ne 'succeeded' -or [string]::IsNullOrWhiteSpace($job.dataset_id)) {
        throw '取り込みが正常完了していません。import結果のstate/errorを確認してください。'
    }
    $DatasetId = $job.dataset_id
    Save-Json (Join-Path $logDirectory 'import.json') $job
    Write-Host "取り込み完了。DatasetId: $DatasetId（以後の失敗時はPublishで再登録できます）"
}

$dataset = Invoke-TileCli 'dataset' @('datasets', 'show', '--dataset', $DatasetId)
$details = Get-Property (Get-Property $dataset 'info') 'details'
$capabilities = Get-Property $details 'capabilities'
$hasLabels = Get-Property $capabilities 'labels'
if ($hasLabels -isnot [bool] -or -not $hasLabels) {
    throw 'この完成DBには名称が収録されていません。standard-v2で取り込んだDatasetIdを指定してください。'
}
(Get-Property $details 'labels') | ConvertTo-Json -Depth 20 | Out-Host
Write-Host "不正な面の除外結果はdataset記録のinfo.details.skipped_areasを確認してください。"
$prepareTerrain = $Terrain -or -not [string]::IsNullOrWhiteSpace($ElevationInput)
if ($prepareTerrain -and (-not (Get-Property $capabilities 'elevation') -or -not (Get-Property $capabilities 'contours'))) {
    throw '地形背景には標高・等高線を収録した完成DBが必要です。Publish時は-Terrainを外すか、DEM付きで取り込み直してください。'
}

function Publish-Background([string]$Label, [string]$BackgroundName, [bool]$WithTerrain) {
    $toggle = if ($WithTerrain) { 'on' } else { 'off' }
    $profile = Invoke-TileCli "$Label-prepare" @('datasets', 'prepare', '--dataset', $DatasetId,
        '--style', 'osm-like-v1', '--roads', 'on', '--buildings', 'on', '--labels', 'on', '--language', 'ja',
        '--contours', $toggle, '--hillshade', $toggle)
    if ([string]::IsNullOrWhiteSpace($profile.render_id)) { throw '描画世代のrender_idがありません。' }
    $background = Invoke-TileCli "$Label-background" @('background', 'add', '--dataset', $DatasetId,
        '--render', $profile.render_id, '--name', $BackgroundName)
    $url = Invoke-TileCli "$Label-url" @('url', '--dataset', $DatasetId, '--render', $profile.render_id)
    return [ordered]@{ render_id = $profile.render_id; background = $background; url = $url }
}

$result = [ordered]@{
    completed_at = [DateTimeOffset]::Now.ToString('o')
    dataset_id = $DatasetId
    exe = $ExePath
    config = $ConfigPath
    normal = (Publish-Background 'normal' $Name $false)
    terrain = $null
}
# 地形側で失敗しても通常地図の登録結果を残す。
$resultPath = Join-Path $logDirectory 'result.json'
Save-Json $resultPath $result
if ($prepareTerrain) {
    $result.terrain = Publish-Background 'terrain' ($Name + '・地形') $true
    Save-Json $resultPath $result
}
Write-Host "背景登録が完了しました: $resultPath"
Write-Host "通常地図URL: $($result.normal.url.url)"
Write-Host 'アプリを起動し、地図の背景一覧で登録した地図を選んでください。既定背景は自動変更しません。'
