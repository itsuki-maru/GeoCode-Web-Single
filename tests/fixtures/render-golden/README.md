# 描画世代分離前の固定画像

基準commitは`9c30ae1a8c84622132a364d63d6cd64dc753bbbe`。このcommitの`geometry.rs`、`tile.rs`、`style.rs`、`renderer.rs`とCargo.lockを`git show`で一時領域へ取り出し、独立した小さなcrateで35件のPNG・RGBA hashを生成した。現在の実装から期待画像を生成したものではない。

比較入力は`tests/render_golden_support/mod.rs`。全道路クラスとリンク、表示ズーム境界、線幅補間、層・重なり順、閉ループ、短い端部、折り返し、隣接4タイル、世界端、空タイルを含む。入力の書式変更前のSHA256、旧ソースのSHA256、Cargo.lock、コンパイラ・実行環境は`manifest.json`に記録する。

`tests/render_golden.rs`は現在のRGBAと固定画像を比較する。PNGの圧縮バイト列は固定せず、復号後の画素と、寸法・色解釈に関係するPNGチャンクを照合する。現在の描画器で期待値を自動更新して、差を隠す運用は行わない。

描画結果を変更する場合は、該当する互換性版、期待する画素差、基準画像の更新理由を一緒に確認する。`scripts/check-render-compatibility.mjs`の補助指紋は、この入力・基準画像の差し替えも検出する。指紋自体は実行時の描画世代には使用しない。
