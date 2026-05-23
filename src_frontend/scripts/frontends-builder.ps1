# 依存関係を更新するかのフラグオプション`-d`を引数で受け取る
Param(
    [switch]$d,
    [switch]$SkipCargoBuild
)

$ErrorActionPreference = "Stop"

Function Invoke-ExternalCommand($command, $arguments)
{
    & $command @arguments
    if ($LASTEXITCODE -ne 0)
    {
        throw "$command $($arguments -join ' ') failed with exit code $LASTEXITCODE"
    }
}

$dependsDeleteFlag = $false

if ($d)
{
    $dependsDeleteFlag = $true
}

# パスを確認して存在すれば削除する関数
Function CheckExistsPath($checkPath)
{
    if (Test-Path $checkPath)
    {
        Remove-Item -Recurse -Force $checkPath
    }
}

# このPowerShellファイルのディレクトリ
$scriptDir = $PSScriptRoot
$projectDir = Split-Path -Path $scriptDir -Parent # src_frontend

# frontendディレクトリ
$frontendDir = Join-Path -Path $projectDir -ChildPath "frontend"
$frontendDistDir = Join-Path -Path $frontendDir -ChildPath "dist"

# frontend-adminディレクトリ
$frontendAdminDir = Join-Path -Path $projectDir -ChildPath "frontend-admin"
$frontendAdminDistDir = Join-Path -Path $frontendAdminDir -ChildPath "dist"

# frontend-mobileディレクトリ
$frontendMobileDir = Join-Path -Path $projectDir -ChildPath "frontend-mobile"
$frontendMobileDistDir = Join-Path -Path $frontendMobileDir -ChildPath "dist"

# templates ディレクトリ
$rootDir = Split-Path -Path $projectDir -Parent
$rustTemplatesDir = Join-Path -Path $rootDir -ChildPath "src/templates"

# 最終的なフロントエンド成果物の配布用ディレクトリ
$prepareDistributionDir = Split-Path -Path $projectDir -Parent
$distributionDir = Join-Path -Path $prepareDistributionDir -ChildPath "dist"

# mainディレクトリ
$mainDir = Join-Path -Path $projectDir -ChildPath "main"

$faviconDir = Join-Path -Path $mainDir -ChildPath "dist/favicon.ico"
$mainDistDir = Join-Path -Path $mainDir -ChildPath "dist"
$pngFiles = Join-Path -Path $mainDir -ChildPath "dist/*.png"
$jsFiles = Join-Path -Path $mainDir -ChildPath "dist/*.js"
$mjsFiles = Join-Path -Path $mainDir -ChildPath "dist/*.mjs"
$cssFiles = Join-Path -Path $mainDir -ChildPath "dist/*.css"
$jsonFiles = Join-Path -Path $mainDir -ChildPath "dist/*.json"
$svgFiles = Join-Path -Path $mainDir -ChildPath "dist/*.svg"
$movedDir = Join-Path -Path $mainDir -ChildPath "dist/assets/"

# 前回のビルドファイルが存在する場合は削除
foreach ($checkPath in $mainDistDir, $frontendDistDir, $frontendMobileDistDir, $frontendAdminDistDir, $distributionDir)
{
    CheckExistsPath $checkPath
}

#################### frontendの処理 ####################
Set-Location $frontendDir

$nodeModules = Join-Path -Path $frontendDir -ChildPath  "node_modules"

# 依存関係を更新する場合の処理
if ($dependsDeleteFlag)
{
    CheckExistsPath $nodeModules
}

# node_modulesが存在しなければnpm installを実行
if (-Not (Test-Path $nodeModules))
{
    Invoke-ExternalCommand "npm" @("install")
}

# ビルド
Invoke-ExternalCommand "npm" @("run", "type-check")
Invoke-ExternalCommand "npm" @("run", "build-only")

# HTMLファイルパス
$targetHtml = Join-Path -Path $frontendDir -ChildPath "dist/index.html"

# favicon.icoのパス変更
(Get-Content -Path $targetHtml) | ForEach-Object {
    $_ -replace 'href="./favicon.ico"', 'href="/assets/favicon.ico"'
} | Set-Content -Path $targetHtml

# qrcode.min.jsのパス変更
(Get-Content -Path $targetHtml) | ForEach-Object {
    $_ -replace 'src="./qrcode.min.js"', 'src="/assets/qrcode.min.js"'
} | Set-Content -Path $targetHtml

# manifest-tab.jsonのパス変更
(Get-Content -Path $targetHtml) | ForEach-Object {
    $_ -replace 'href="./manifest-tab.json"', 'href="/assets/manifest-tab.json"'
} | Set-Content -Path $targetHtml

# apple-touch-icon.pngのパス変更
(Get-Content -Path $targetHtml) | ForEach-Object {
    $_ -replace 'href="./apple-touch-icon.png"', 'href="/assets/apple-touch-icon.png"'
} | Set-Content -Path $targetHtml

############### frontend-mobileの処理 ###############

Set-Location $frontendMobileDir

$nodeModules = Join-Path -Path $frontendMobileDir -ChildPath  "node_modules"

# 依存関係を更新する場合の処理
if ($dependsDeleteFlag)
{
    CheckExistsPath $nodeModules
}

# node_modulesが存在しなければnpm installを実行
if (-Not (Test-Path $nodeModules))
{
    Invoke-ExternalCommand "npm" @("install")
}

# ビルド
Invoke-ExternalCommand "npm" @("run", "type-check")
Invoke-ExternalCommand "npm" @("run", "build-only")
# HTMLファイルパス
$targetHtml = Join-Path -Path $frontendMobileDir -ChildPath "dist/index.html"

# favicon.icoのパス変更
(Get-Content -Path $targetHtml) | ForEach-Object {
    $_ -replace 'href="./favicon.ico"', 'href="/assets/favicon.ico"'
} | Set-Content -Path $targetHtml

# qrcode.min.jsのパス変更
(Get-Content -Path $targetHtml) | ForEach-Object {
    $_ -replace 'src="./qrcode.min.js"', 'src="/assets/qrcode.min.js"'
} | Set-Content -Path $targetHtml

# manifest.jsonのパス変更
(Get-Content -Path $targetHtml) | ForEach-Object {
    $_ -replace 'href="./manifest.json"', 'href="/assets/manifest.json"'
} | Set-Content -Path $targetHtml

# apple-touch-icon.pngのパス変更
(Get-Content -Path $targetHtml) | ForEach-Object {
    $_ -replace 'href="./apple-touch-icon.png"', 'href="/assets/apple-touch-icon.png"'
} | Set-Content -Path $targetHtml

Rename-Item -Path $targetHtml -NewName "index-mobile.html"


############### frontend-adminの処理 ###############

Set-Location $frontendAdminDir

$nodeModules = Join-Path -Path $frontendAdminDir -ChildPath  "node_modules"

# 依存関係を更新する場合の処理
if ($dependsDeleteFlag)
{
    CheckExistsPath $nodeModules
}

# node_modulesが存在しなければnpm installを実行
if (-Not (Test-Path $nodeModules))
{
    Invoke-ExternalCommand "npm" @("install")
}

# ビルド
Invoke-ExternalCommand "npm" @("run", "type-check")
Invoke-ExternalCommand "npm" @("run", "build-only")
# HTMLファイルパス
$targetHtml = Join-Path -Path $frontendAdminDir -ChildPath "dist/index.html"

# favicon.icoのパス変更
(Get-Content -Path $targetHtml) | ForEach-Object {
    $_ -replace 'href="./favicon.ico"', 'href="/assets/favicon.ico"'
} | Set-Content -Path $targetHtml

Rename-Item -Path $targetHtml -NewName "index-admin.html"

############### mainの処理 ###############

Set-Location $mainDir
# frontend/distとfrontend-admin/distとfrontend-mobile/dist配下のファイルをmainディレクトリにコピー
Copy-Item -Path $frontendDistDir -Destination "./" -Recurse -Force
Copy-Item -Path $frontendAdminDistDir -Destination "./" -Recurse -Force
Copy-Item -Path $frontendMobileDistDir -Destination "./" -Recurse -Force

# 静的ファイルを配置移動
Move-Item -Path $faviconDir -Destination $movedDir
Move-Item -Path $pngFiles -Destination $movedDir
Move-Item -Path $jsFiles -Destination $movedDir
Move-Item -Path $mjsFiles -Destination $movedDir
Move-Item -Path $cssFiles -Destination $movedDir
Move-Item -Path $jsonFiles -Destination $movedDir
Move-Item -Path $svgFiles -Destination $movedDir

# 最終的なフロントエンド成果物の配置ディレクトリを作成
New-Item -Type Directory $distributionDir
Set-Location $mainDistDir
Copy-Item -Path "./*" -Destination $distributionDir -Recurse -Force
Copy-Item -Path $rustTemplatesDir -Destination $distributionDir -Recurse -Force

# プロジェクトディレクトリに移動し、Rustをコンパイル
Set-Location $prepareDistributionDir
if (-Not $SkipCargoBuild)
{
    Invoke-ExternalCommand "cargo" @("build", "--release")
}
