// モードの説明を切り替える関数
// 閲覧・入力・移動モードに応じて UI とドラッグ可否を切り替える
function handleRadioChange(event) {
  const mode = event.target.value;
  setShapeGeometryEditingMode(mode);
  // 左下のコンテナを取得または作成
  let modeDescriptionContainer = document.getElementById("mode-description");
  if (!modeDescriptionContainer) {
    modeDescriptionContainer = document.createElement("div");
    modeDescriptionContainer.id = "mode-description";
    modeDescriptionContainer.style.position = "absolute";
    modeDescriptionContainer.style.left = "10px";
    modeDescriptionContainer.style.padding = "10px";
    modeDescriptionContainer.style.backgroundColor = "rgba(255, 255, 255, 0.7)";
    document.body.appendChild(modeDescriptionContainer);
  }

  // モードに応じた説明の設定とマーカードラッグの有効化・無効化切り替え
  if (mode === "view") {
    console.log("View Mode Changed.");
    modeDescriptionContainer.innerHTML =
      "閲覧モード: 現在のモードは閲覧のみ可能です。";
    // クラスタ内の全てのマーカーに対してドラッグを無効にする
    markersClusterGroup.eachLayer(function (marker) {
      if (marker.dragging) {
        // marker.dragging が存在するか確認
        marker.dragging.disable();
      }
    });
  } else if (mode === "input") {
    console.log("Input Mode Changed.");
    modeDescriptionContainer.innerHTML =
      "入力モード: マーカーの追加と図形への頂点追加が可能です。";
    markersClusterGroup.eachLayer(function (marker) {
      if (marker.dragging) {
        // marker.dragging が存在するか確認
        marker.dragging.disable();
      }
    });
  } else if (mode === "edit") {
    console.log("Edit Mode Changed.");
    modeDescriptionContainer.innerHTML =
      "移動モード: マーカーの移動と図形の頂点・円の移動が可能です。";
    // クラスタ内の全てのマーカーに対してドラッグを有効にする
    markersClusterGroup.eachLayer(function (marker) {
      if (marker.dragging) {
        // marker.dragging が存在するか確認
        marker.dragging.enable();
      }
    });
  }
}

