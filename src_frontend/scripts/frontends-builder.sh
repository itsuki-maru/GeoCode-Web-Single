#!/usr/bin/bash

# 依存関係を更新するかのフラグオプション`-d`を引数で受け取る
DEPENDS_DELETE_FLAG=false

while getopts "d" opt; do
  case $opt in
    d)
      DEPENDS_DELETE_FLAG=true
      ;;
    *)
      echo "Usage: $0 [-d]"
      exit 1
      ;;
  esac
done

#################### 初期設定処理 ####################

# このスクリプトファイルのディレクトリを取得
scriptDir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# src_frontend ディレクトリを取得
projectDir="$(dirname "$scriptDir")"

# プロジェクトルート
projectRoot="$(dirname "$projectDir")"

# frontendのディレクトリを取得
frontendDir="$projectDir/frontend"
frontendDistDir="$frontendDir/dist"

# frontend-adminディレクトリを取得
frontendAdminDir="$projectDir/frontend-admin"
frontendAdminDistDir="$frontendAdminDir/dist"

# frontend-mobileディレクトリを取得
frontendMobileDir="$projectDir/frontend-mobile"
frontendMobileDistDir="$frontendMobileDir/dist"

# templates ディレクトリ
rustTemplatesDir="$projectRoot/src/templates"

# 過去のビルドファイル
distributionDirOld="$projectRoot/dist"

# mainディレクトリ
mainDir="$projectDir/main"
mainDistDir="$mainDir/dist"

mainDistAssetsDir="$mainDir/dist/assets/"
faviconDir="$mainDir/dist/favicon.ico"
publicImageDir="$mainDir/dist/*.png"
qrcodeJsDir="$mainDir/dist/qrcode.min.js"
xssJsDir="$mainDir/dist/xss.min.js"
githubCssDir="$mainDir/dist/github.css"
manifestJsonDir="$mainDir/dist/manifest.json"
manifestJsonMovedDir="$mainDir/dist/assets/manifest.json"
manifestJsonIPadDir="$mainDir/dist/manifest-tab.json"
manifestJsonIPadMovedDir="$mainDir/dist/assets/manifest-tab.json"


########## 前回のビルドファイルが存在する場合は削除する処理 ##########

if [ -d "$mainDistDir" ]; then
    rm -rf "$mainDistDir"
    echo "Directory '$mainDistDir' has been removed."
else
    echo "Directory '$mainDistDir' does not exist."
fi

if [ -d "$frontendDistDir" ]; then
    rm -rf "$frontendDistDir"
    echo "Directory '$frontendDistDir' has been removed."
else
    echo "Directory '$frontendDistDir' does not exist."
fi

if [ -d "$frontendAdminDistDir" ]; then
    rm -rf "$frontendAdminDistDir"
else
    echo "Directory '$frontendAdminDistDir' does not exist."
fi

if [ -d "$frontendMobileDistDir" ]; then
    rm -rf "$frontendMobileDistDir"
    echo "Directory '$frontendMobileDistDir' has been removed."
else
    echo "Directory '$frontendMobileDistDir' does not exist."
fi

if [ -d "$distributionDirOld" ]; then
    rm -rf "$distributionDirOld"
    echo "Directory '$distributionDirOld' has been removed."
else
    echo "Directory '$distributionDirOld' does not exist."
fi

#################### frontendの処理 ####################

cd $frontendDir

nodeModules="$frontendDir/node_modules"

# -dオプション設定時にはnode_modulesを削除
if [ "$DEPENDS_DELETE_FLAG" = true ]; then
    rm -rf "$nodeModules"
    echo "Directory '$nodeModules' has been removed."
else
    echo "Directory '$TARGET_DIR' exists, but -d option was not provided. No action taken."
fi

# node_modulesが存在しなければnpm installを実行
if [ ! -d "$nodeModules" ]; then
    npm install
else
    echo "Directory '$nodeModules' exist."
fi

# ビルド
npm run build
# HTMLファイルパス
targetHtml="$frontendDir/dist/index.html"

# favicon.icoのパス変更
sed -i 's|href="./favicon.ico"|href="/assets/favicon.ico"|g' "$targetHtml"

# qrcode.min.jsのパス変更
sed -i 's|src="./qrcode.min.js"|src="/assets/qrcode.min.js"|g' "$targetHtml"

# manifest-tab.jsonのパス変更
sed -i 's|href="./manifest-tab.json"|href="/assets/manifest-tab.json"|g' "$targetHtml"

# apple-touch-icon.pngのパス変更
sed -i 's|href="./apple-touch-icon.png"|href="/assets/apple-touch-icon.png"|g' "$targetHtml"

############### frontend-mobileの処理 ###############

cd $frontendMobileDir

nodeModules="$frontendMobileDir/node_modules"

# -dオプション設定時にはnode_modulesを削除
if [ "$DEPENDS_DELETE_FLAG" = true ]; then
    rm -rf "$nodeModules"
    echo "Directory '$nodeModules' has been removed."
else
    echo "Directory '$TARGET_DIR' exists, but -d option was not provided. No action taken."
fi

# node_modulesが存在しなければnpm installを実行
if [ ! -d "$nodeModules" ]; then
    npm install
else
    echo "Directory '$nodeModules' exist."
fi

# ビルド
npm run build
# HTMLファイルパス
targetHtml="$frontendMobileDir/dist/index.html"

# favicon.icoのパス変更
sed -i 's|href="./favicon.ico"|href="/assets/favicon.ico"|g' $targetHtml

# qrcode.min.jsのパス変更
sed -i 's|src="./qrcode.min.js"|src="/assets/qrcode.min.js"|g' "$targetHtml"

# manifest.jsonのパス変更
sed -i 's|href="./manifest.json"|href="/assets/manifest.json"|g' "$targetHtml"

# apple-touch-icon.pngのパス変更
sed -i 's|href="./apple-touch-icon.png"|href="/assets/apple-touch-icon.png"|g' "$targetHtml"

targetHtmlNewName="$frontendMobileDir/dist/index-mobile.html"
mv $targetHtml $targetHtmlNewName


############### frontend-adminの処理 ###############

cd $frontendAdminDir

nodeModules="$frontendAdminDir/node_modules"

# -dオプション設定時にはnode_modulesを削除
if [ "$DEPENDS_DELETE_FLAG" = true ]; then
    rm -rf "$nodeModules"
    echo "Directory '$nodeModules' has been removed."
else
    echo "Directory '$TARGET_DIR' exists, but -d option was not provided. No action taken."
fi

# node_modulesが存在しなければnpm installを実行
if [ ! -d "$nodeModules" ]; then
    npm install
else
    echo "Directory '$nodeModules' exist."
fi

# ビルド
npm run build
# HTMLファイルパス
targetHtml="$frontendAdminDir/dist/index.html"

# favicon.icoのパス変更
sed -i 's|href="./favicon.ico"|href="/assets/favicon.ico"|g' $targetHtml

targetHtmlNewName="$frontendAdminDir/dist/index-admin.html"
mv $targetHtml $targetHtmlNewName


############### mainの処理 ###############

cd $mainDir

# frontend/distとfrontend-admin/distとfrontend-mobile/dist配下のファイルをmainディレクトリにコピー
cp -r $frontendDistDir ./
cp -r $frontendMobileDistDir ./
cp -r $frontendAdminDistDir ./

# favicon.icoをassets配下に移動
mv $faviconDir $mainDistAssetsDir
mv $publicImageDir $mainDistAssetsDir
mv $qrcodeJsDir $mainDistAssetsDir
mv $xssJsDir $mainDistAssetsDir
mv $githubCssDir $mainDistAssetsDir

cd $mainDistDir

# JSファイルを全てmain/dist/assetsへ移動
mv -f ./*.js $mainDistAssetsDir
# CSSファイルを全てmain/dist/assetsへ移動
mv -f ./*.css $mainDistAssetsDir

# manifest.jsonをassets配下に移動
mv $manifestJsonDir $manifestJsonMovedDir
# manifest-tab.jsonをassets配下に移動
mv $manifestJsonIPadDir $manifestJsonIPadMovedDir

# フロントエンド成果物配布用ディレクトリ作成
cd $mainDistDir
cp -r $mainDistDir $projectRoot
cp -r $rustTemplatesDir "$projectRoot/dist"