#!/bin/bash
# ビルド済みの各画面とテンプレートを、Rust に埋め込む dist/ へ集約する。
# このスクリプトでは npm によるビルドは行わない。

# コマンド失敗・未定義変数・パイプ内の失敗を検出したら処理を停止する。
set -euo pipefail

# 実行時のカレントディレクトリに依存しないよう、このファイルから各パスを求める。
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
project_root="$(cd "$script_dir/../.." && pwd)"
frontend_root="$project_root/src_frontend"

# 集約用と配布用の成果物を作り直し、前回の不要なファイルが残るのを防ぐ。
# 各フロントエンドの dist/ は、この後のコピー元として使用する。
output="$frontend_root/main/dist"
rm -rf "$output" "$project_root/dist"
mkdir -p "$output/assets"

# PC・モバイル・管理画面の成果物を順に集約する。
for name in frontend frontend-mobile frontend-admin; do
    source_dir="$frontend_root/$name/dist"

    # ビルド結果の HTML がない場合は、不完全な成果物を作らずに停止する。
    test -f "$source_dir/index.html"

    # 同名の index.html が上書きされないよう、画面ごとに保存名を分ける。
    case "$name" in
        frontend) page=index.html ;;
        frontend-mobile) page=index-mobile.html ;;
        frontend-admin) page=index-admin.html ;;
    esac
    # HTML 以外のファイルとディレクトリをコピーし、assets/ などを統合する。
    # ファイル名に空白や改行が含まれていても扱えるよう、NUL 区切りで読み込む。
    while IFS= read -r -d '' entry; do
        cp -r "$entry" "$output/"
    done < <(find "$source_dir" -mindepth 1 -maxdepth 1 ! -name index.html -print0)

    # アイコンとマニフェストの参照先を、集約後の配信パス /assets/ に合わせる。
    # コピー元の HTML は変更せず、画面ごとの保存名で集約先に書き出す。
    sed -e 's|href="./favicon.ico"|href="/assets/favicon.ico"|g' \
        -e 's|href="./manifest.json"|href="/assets/manifest.json"|g' \
        -e 's|href="./manifest-tab.json"|href="/assets/manifest-tab.json"|g' \
        -e 's|href="./apple-touch-icon.png"|href="/assets/apple-touch-icon.png"|g' \
        "$source_dir/index.html" > "$output/$page"
done

# 集約先の直下にある JS・CSS・画像・マニフェストを assets/ へ移動する。
# find で実在するファイルだけを対象にし、該当する種類がなくても失敗させない。
find "$output" -maxdepth 1 -type f \
    \( -name '*.js' -o -name '*.css' -o -name '*.svg' -o -name '*.png' \
       -o -name favicon.ico -o -name manifest.json -o -name manifest-tab.json \) \
    -exec mv -t "$output/assets" -- {} +

# Tera テンプレート用スクリプトのビルド結果を確認し、マニフェストごと追加する。
test -f "$frontend_root/template-scripts/dist/template-manifest.json"
cp -r "$frontend_root/template-scripts/dist/." "$output/assets/"

# 集約した成果物を、rust-embed が参照するプロジェクト直下の dist/ へコピーする。
cp -r "$output" "$project_root/dist"

# サーバー側で描画する Tera の HTML テンプレートも、埋め込み対象に含める。
# src/templates/ の直下にある HTML ファイルだけをコピーする。
mkdir -p "$project_root/dist/templates"
find "$project_root/src/templates" -maxdepth 1 -type f -name '*.html' \
    -exec cp -t "$project_root/dist/templates" -- {} +
