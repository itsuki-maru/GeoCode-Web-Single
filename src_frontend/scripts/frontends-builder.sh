#!/bin/bash
set -euo pipefail

delete_dependencies=false
while getopts "d" opt; do
    case "$opt" in
        d) delete_dependencies=true ;;
        *) echo "Usage: $0 [-d]" >&2; exit 1 ;;
    esac
done
# 各フロントエンドのビルド結果を集約するためのスクリプトを実行する。
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
frontend_root="$(cd "$script_dir/.." && pwd)"
for name in frontend frontend-mobile frontend-admin template-scripts; do
    cd "$frontend_root/$name"
    if [ "$delete_dependencies" = true ] || [ ! -d node_modules ]; then
        npm ci
    fi
    npm run build
done
bash "$script_dir/assemble-frontends.sh"
