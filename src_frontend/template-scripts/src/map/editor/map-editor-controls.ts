// @ts-nocheck -- Leaflet編集画面の共有スコープを保つ統合境界。
const TooltipVisibleControl = L.Control.extend({
  options: {
    position: editorEntryProfile.isMobile ? "topleft" : "topright",
  },
  onAdd: function (map) {
    const container = L.DomUtil.create("div", "leaflet-bar leaflet-control");

    // ラジオボタンのHTMLを動的に生成
    const button = L.DomUtil.create(
      "button",
      "custom-control-button",
      container,
    );
    button.innerHTML = "マーカー名表示";

    // ボタンのクリックイベント
    L.DomEvent.on(button, "click", function (e) {
      L.DomEvent.stop(e);
      // ここにカスタム機能を実装
      toggleTooltips();
    });

    // Leafletのクリックイベントとの干渉を避ける
    L.DomEvent.disableClickPropagation(container);
    return container;
  },
});

// 地図にタイルコントロールを追加
const tooltipVisibleControl = new TooltipVisibleControl();
map.addControl(tooltipVisibleControl);
if (editorEntryProfile.isMobile) {
  registerHideableMapControl(tooltipVisibleControl);
}

// ツールチップの表示・非表示を管理する
let isTooltipVisible = false;

// ツールチップの表示非表示を切り替える関数
// マーカー名ツールチップの一括表示を切り替える
// 計測ラベルの表示非表示を切り替える関数
function toggleMeasurementLabels() {
  isMeasurementVisible = !isMeasurementVisible;
  shapeMeasurementManager?.setEnabled(isMeasurementVisible);
  updateMeasurementControlState();
}

// 計測コントロールの表示状態を反映する
// 辺を結合する表示へ切り替える
// 緯度経度入力から対象地点へフォーカスする
// 座標の入力値検査（緯度経度が妥当な数値範囲かを判定する）
// 地図に検索コントロールを追加
const codeSearchControl = createCodeSearchControl();
map.addControl(codeSearchControl);
if (editorEntryProfile.isMobile) {
  registerHideableMapControl(codeSearchControl);
  const markerSearchControl = createFlatMarkerSearchControl({
    onSearch: applyLocalMarkerSearch,
  });
  map.addControl(markerSearchControl);
}

// 現在位置コントロールは共通処理内で追加されるため、追加前後の差分から登録する
const controlsBeforeUserLocation = editorEntryProfile.isMobile
  ? getMapControlContainersSnapshot()
  : null;
const userLocationLayer = initializeUserLocation(map);
if (editorEntryProfile.isMobile) {
  registerNewHideableMapControlContainers(controlsBeforeUserLocation);
}
if (userLocationLayer && !getInitialUserLocationVisibility()) {
  map.removeLayer(userLocationLayer);
}

// 図形描画コントロールを定義
const DrawShapeControl = L.Control.extend({
  options: {
    position: "topleft",
  },
  onAdd: function (map) {
    const container = L.DomUtil.create("div", "leaflet-bar leaflet-control");
    container.id = "draw-control";
    container.innerHTML = `
            <div class="draw-control-wrapper">
                <button type="button" class="draw-control-button" id="draw-toggle-btn">図形ツール</button>
                <div class="draw-control-zone is-collapsed" id="draw-control-panel">
                <input
                    type="text"
                    id="draw-shape-name"
                    class="draw-control-input"
                    maxlength="80"
                    aria-label="図形名"
                    placeholder="図形名を設定（任意）"
                />
                <div class="draw-control-color-row">
                    <span class="draw-control-color-label">色</span>
                    <input
                        type="color"
                        id="draw-shape-color"
                        class="draw-control-color-input"
                        aria-label="図形色"
                        value="#d94841"
                    />
                </div>
                <button type="button" class="draw-control-button" data-draw-mode="polygon">ポリゴン</button>
                    <button type="button" class="draw-control-button" data-draw-mode="polyline">折れ線</button>
                    <button type="button" class="draw-control-button" data-draw-mode="rectangle">矩形</button>
                    <button type="button" class="draw-control-button" data-draw-mode="circle">円</button>
                    <button type="button" class="draw-control-button" data-draw-mode="delete">削除</button>
                    <button type="button" class="draw-control-button" id="draw-undo-btn">削除した図形を戻す</button>
                    <button type="button" class="draw-control-button" id="draw-complete-btn">完了</button>
                    <button type="button" class="draw-control-button" id="draw-cancel-btn">キャンセル</button>
                </div>
            </div>
        `;

    container
      .querySelector("#draw-toggle-btn")
      .addEventListener("click", () => {
        toggleDrawPanel();
      });

    container.querySelectorAll("[data-draw-mode]").forEach((button) => {
      button.addEventListener("click", () => {
        beginDrawing(button.dataset.drawMode);
      });
    });

    container
      .querySelector("#draw-complete-btn")
      .addEventListener("click", async () => {
        await completeActiveDrawing();
      });

    container
      .querySelector("#draw-cancel-btn")
      .addEventListener("click", () => {
        closeShapeNameEditor();
        resetDrawingState("図形描画: キャンセルしました。");
      });

    container
      .querySelector("#draw-undo-btn")
      .addEventListener("click", async () => {
        await undoDeletedShape();
      });

    updateUndoButtonState();
    toggleDrawPanel(false);

    L.DomEvent.disableClickPropagation(container);
    return container;
  },
});

const drawShapeControl = new DrawShapeControl();
map.addControl(drawShapeControl);
if (editorEntryProfile.isMobile) registerHideableMapControl(drawShapeControl);
const suppressInitialShapeRendering =
  shouldSuppressInitialShapeRendering(shapesFromAxum);
restoreSavedShapes();
if (!suppressInitialShapeRendering && getInitialShapeLayerVisibility()) {
  drawnShapesGroup.addTo(map);
}
applyMeasurementVisibilityToDrawnShapesGroup();
const shapeNameVisibilityLayer = L.layerGroup();
if (!suppressInitialShapeRendering && getInitialShapeNameVisibility()) {
  shapeNameVisibilityLayer.addTo(map);
}
shapeNameLabelManager = createViewportShapeLabelManager({
  map,
  getLayers: () => searchableShapeLayers,
  getLabelLatLng: (layer) => getShapeLabelLatLng(layer),
  bindLabel: bindShapeNameLabelTooltip,
  enabled: map.hasLayer(shapeNameVisibilityLayer),
});
shapeNameLabelManager.refresh();
shapeMeasurementManager = createViewportShapeMeasurementManager({
  map,
  getLayers: () => searchableShapeLayers,
  attachMarkers: (layer, bounds) =>
    attachShapeMeasurementMarkers(layer, bounds),
  removeMarkers: removeShapeMeasurementMarkers,
});
const shapeLayerOverlays = {
  マーカー: markersClusterGroup,
  図形: drawnShapesGroup,
  図形名: shapeNameVisibilityLayer,
};
if (userLocationLayer) {
  shapeLayerOverlays["現在位置"] = userLocationLayer;
}
const shapeLayersControl = L.control.layers(null, shapeLayerOverlays, {
  collapsed: false,
});
shapeLayersControl.addTo(map);
if (editorEntryProfile.isMobile) registerHideableMapControl(shapeLayersControl);
map.on("overlayadd", function (event) {
  if (event.layer === markersClusterGroup) {
    saveMarkerVisibility(true);
    return;
  }
  if (event.layer === shapeNameVisibilityLayer) {
    shapeNameLabelManager.setEnabled(true);
    saveShapeNameVisibility(true);
    return;
  }
  if (event.layer === userLocationLayer) {
    saveUserLocationVisibility(true);
    return;
  }

  if (event.layer !== drawnShapesGroup) {
    return;
  }

  saveShapeLayerVisibility(true);
  setTimeout(() => {
    renderVisibleShapes();
    bindVisibleShapeLabelEvents();
    applyMeasurementVisibilityToDrawnShapesGroup();
    updateShapeVertexAddTargetStyles();
  }, 0);
});
map.on("overlayremove", function (event) {
  if (event.layer === markersClusterGroup) {
    saveMarkerVisibility(false);
    return;
  }
  if (event.layer === shapeNameVisibilityLayer) {
    shapeNameLabelManager.setEnabled(false);
    saveShapeNameVisibility(false);
    return;
  }
  if (event.layer === userLocationLayer) {
    saveUserLocationVisibility(false);
    return;
  }

  if (event.layer === drawnShapesGroup) {
    clearShapeGeometryEditing();
    saveShapeLayerVisibility(false);
  }
});

// 測定結果ラベル表示・非表示コントロールの定義
const MeasurementVisibleControl = L.Control.extend({
  options: {
    position: "topleft",
  },
  onAdd: function (map) {
    const container = L.DomUtil.create(
      "div",
      "leaflet-bar leaflet-control measurement-control",
    );
    const button = L.DomUtil.create(
      "button",
      "custom-control-button",
      container,
    );
    button.innerHTML = "図形の計測";
    const mergeButton = L.DomUtil.create(
      "button",
      "custom-control-button is-hidden",
      container,
    );
    mergeButton.id = "measurement-merge-toggle-btn";
    mergeButton.type = "button";
    mergeButton.innerHTML = "辺を結合";
    mergeButton.setAttribute("aria-pressed", "false");

    L.DomEvent.on(button, "click", function (e) {
      L.DomEvent.stop(e);
      toggleMeasurementLabels();
    });

    L.DomEvent.on(mergeButton, "click", function (e) {
      L.DomEvent.stop(e);
      toggleMeasurementSegmentMerge();
    });

    L.DomEvent.disableClickPropagation(container);
    updateMeasurementControlState();
    return container;
  },
});

const measurementVisibleControl = new MeasurementVisibleControl();
map.addControl(measurementVisibleControl);
if (editorEntryProfile.isMobile) {
  registerHideableMapControl(measurementVisibleControl);
}

// 指定地点へ地図を移動し、必要ならマーカーを強調表示する
