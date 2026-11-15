# ローカル地図の描画世代識別の実装記録

実施日：2026-11-12。[修正計画](LOCAL_TILE_RENDER_IDENTITY_PLAN.md)のR0〜R6に対応する。開始時の本体commitは`9c30ae1`。事前作成した計画と文書一覧の未コミット変更を保持した。

## R0〜R2：契約と生成核

`src/tilegen/identity.rs`へ、ビルド来歴と独立した取り込み・描画互換性契約を追加した。識別形式はversion 2、用途別の接頭辞を長さ付きUTF-8、文字列長をu64、整数をu32のリトルエンディアンで直列化する。Styleのf32はビット列を使う。値の順序は関数内で固定し、JSON整形・パス・時刻・製品版・ビルド環境を混ぜない。

描画契約は、実際に読むschema/geometry版、描画・読取・座標・画像解釈の互換性版、数値演算系列、実Style hash、寸法、画素・色・アルファを持つ。対応形式の一覧を入力にせず、形式追加だけで既存契約を変えない。Styleの設定値は描画とhashから共通参照し、線幅の演算順は維持した。

形式1/1の初期契約IDは`7c68847da1551594c29c3c95e2e379fc78ce36f8f3e1b4dee868a39fff187207`、Style hashは`b06a587abde3fac664b32685abce4ce92e2a8d6533d28a97f1d19a319d4f0424`。固定ベクトルで確認する。

新規取り込みのdataset IDは入力PBF、取り込み互換性版と条件から決定し、`importer_version`も安定した取り込み互換性版にした。既存完成DBのmetadata・dataset ID・importer版は変更せずに受理する。SDKのキーと本体のrender IDは同じ描画契約を使い、診断用の全体ビルドIDを除外した。

## R3〜R4：生成判定と旧情報の保持

`src/local_tiles/profile.rs`へv2の構成・形式・契約hash・datasetを含むprofile IDの照合を集約した。service・CLI・事前生成はビルドID一致ではなく同じ判定を使う。照会ではprofileを追加せず、登録先が消失した場合の行単位エラーは接続・描画世代準備をせずに維持した。

catalog schema版1とSQL checksum、完成DB形式、manifest v1は変更していない。既存`build_id`列はprofile登録時の来歴として保持し、v2契約を`info_json`へ保存する。同じ契約の再登録では既存profile・背景IDを再利用する。

CLIは`current_build`・`app_build_id`の診断と`render_compatible`を分離する。`current_build=false / render_compatible=true`でも同じURLへ生成でき、410と誤案内しない。`local-tiles build-info --json`は設定・DB不要で、実exeの契約・来歴・認定状況を返す。

旧profile、URL、PNG、manifest、履歴、背景、共有は保持する。未知の旧形式はPNG hitを維持し、missは410。旧manifestを新世代へ持ち替えず409とする。旧方式からの初回切替だけ`datasets prepare`・`background add`で新方式を準備し、その後のコメントやCLI等の変更では再準備・再登録を不要にする。

## 実行構成の認定

`res/tile-render-execution.json`で、Rust 1.99.1、Windows x64、標準CPU機能、opt-level 0/3、追加flags・アプリfeature・compiler wrapperなしの構成を管理する。tiny-skia・libm・rusqlite・serde_json・sha2・osmpbfreader・protobuf・flate2から到達する94依存の版・取得元・機能・依存辺を照合する。パス、製品版、関係ない依存は指紋へ入れない。

実際のCargo解決結果はビルド時に取得し、認定結果をexeへ同梱する。未認定時は新規生成等を503で拒否し、保存PNG・照会は維持する。設定・環境変数による強制解除は設けていない。CI/releaseのtoolchainも認定版へ固定し、配布直前に実exeの`build-info`を確認する。

## R4〜R5：固定画像とCI

変更前のcommit `9c30ae1`の描画ソースとCargo.lockを取り出し、小さな参照用crateで35画像を固定した。入力・ソース・lockのhash、compiler/targetを`tests/fixtures/render-golden/manifest.json`へ記録した。変更後の実装から期待値を再生成していない。

通常・リンク・表示ズーム境界・層・重なり・丸線・閉ループ・継ぎ目・世界端・空タイルを含む。RGBA、PNG復号後の画素、寸法・色解釈チャンクが旧画像と一致し、debugとreleaseの両方で成功した。圧縮バイト列の違いだけでは世代を変えない。

`scripts/check-render-compatibility.mjs`と小さなRust検証crateが、synで通常コメント・Rustdocを除いた補助指紋、推移依存、固定画像、互換性判断記録を照合する。補助指紋は描画世代へ使わない。確認対象22ファイルの記録は`tests/fixtures/render-compatibility-review.json`。新規・欠落・内容差・不正構成を検出する。関連変更時は、契約更新または据置理由と回帰結果を確認して記録を更新する。

## 自動検証

- Rust全体回帰と失敗分の再検証を同じ試験単位で集計し、542件成功・6件ignore。ignoreは手動ブラウザfixtureと外部検証資材が必要な既存試験で、実行していない。
- libは最終状態で212件成功。初回全体ではlocalhost通信4件が制限で失敗し、制限外で再実行した。ジオコーディング・proxy・背景設定の3統合試験群も同じ理由で再実行し、4件成功した。
- 取り込み元の来歴変更でもSDKキー不変、異なるprofile登録元でもURL・PNG hit/miss・背景ID・事前生成再開が不変、旧DBのbytes不変、旧manifest保護、未認定時の503と保存PNG利用を確認した。
- 固定35画像は本体のdebug/release比較に成功。先行の小crateでも描画unit 30件と固定画像比較が成功した。
- 補助検証crateの7件、確認記録照合、共通フロント792ファイルの一致、4構成の型検査・ビルドと隔離資材集約が成功した。

初回の並列コンパイルではWindows依存のコンパイラが診断を残さず終了したため、制限外・並列数1で再実行して全ターゲットのcheckに成功した。試験環境のために依存やアサーションを弱める変更は行っていない。

## R6：配布と出力容量

最終コードと共通資材でexe・NSIS・MSIを作成した。NSIS資材の取得がDNS制限で失敗したため、同じ隔離出力で制限外のパッケージ作成を再実行し、成功した。

| 成果物（`target/render-identity-verification/rust/release`からの相対位置） | サイズ |
| --- | --- |
| `geocode_web_single.exe` | 49,112,064 bytes |
| `bundle/nsis/GeoCode-Web-SingleBin_1.14.0_x64-setup.exe` | 11,725,356 bytes |
| `bundle/msi/GeoCode-Web-SingleBin_1.14.0_x64_ja-JP.msi` | 17,166,336 bytes |

単体exeのSHA256は`1e12a51cbbdc97ac57149efbc81d899836202265f2a1483f6aaea93a5113120c`。全成果物のhashと検証集計は`target/render-identity-verification/delivery-summary.json`へ保存した。実exeの`build-info`が`execution.verified=true`を返すことを確認した。

最終exeを`GEOCODE_TEST_CLI_EXE`へ指定し、CLI・保存と再開・XYZ配信の3試験群13件を再実行して成功した。試験前後でexeのhashが変わらないことも確認した。`cargo fmt --all --check`、最終`cargo check --locked --offline --all-targets`、補助指紋・文書リンク・YAMLの検査も成功した。

実アプリ・ブラウザ起動、インストール、公開、Gitコミットは行っていない。全体ログは`tests.log`、再検証は`lib-tests.log`・`network-tests.log`、配布用exe試験は`delivery-tests.log`、配布物作成は`package.log`に記録した（すべて`target/render-identity-verification`内）。

出力は`target/render-identity-verification/`へ集約し、本体のdebug情報とincrementalを抑制した。releaseの既存依存cacheは本体exeとPDBを除いて再利用し、利用者の既存`target/release`のexeやroot distを上書きしていない。検証出力全体は約9GiB、小さな検証ツールのcacheは約245MiB、固定画像等は約122KB。

利用者の実JSON・本体DB・catalog・完成DB・PNG・履歴は操作していない。切替方法と初回世代の準備は[ローカル地図](../LOCAL_TILES.md)を参照する。
