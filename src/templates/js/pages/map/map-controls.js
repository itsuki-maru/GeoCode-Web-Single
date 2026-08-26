const TooltipVisibleControl = L.Control.extend({
  options: {
    position: "topright",
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
map.addControl(new TooltipVisibleControl());

// ツールチップの表示・非表示を管理する
let isTooltipVisible = false;

// ツールチップの表示非表示を切り替える関数
// 計測ラベルの表示非表示を切り替える関数
function toggleMeasurementLabels() {
  isMeasurementVisible = !isMeasurementVisible;
  shapeMeasurementManager?.setEnabled(isMeasurementVisible);
  updateMeasurementControlState();
}

// 計測コントロールの表示状態を反映する
// 辺を結合する表示へ切り替える
// 指定 ID のマーカーポップアップを開く関数

// サーバーに新しい座標とIDを送信してデータを更新する関数
// マーカー移動後の座標をサーバーへ反映する
function updateServer(id, lat, lng) {
  let url = `/marker/update-marker-latlng?marker_id=${id}&latitude=${lat}&longitude=${lng}`;
  // ラジオボタンの状態を確認
  let isEditMode = document.getElementById("editMode").checked;
  // 編集モードでなければは何もしない
  if (!isEditMode) {
    return;
  }

  fetchWithAuth(url, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
    },
  })
    .then((response) => {
      if (!response.ok) {
        throw new Error("Network response was not ok");
      }
      return response.json();
    })
    .then((data) => {
      // 必要に応じて、サーバーからのレスポンスを処理する
    })
    .catch((error) => {
      console.log(
        "There was a problem with the fetch operation:",
        error.message,
      );
    });
}

function handleShapeDrawLatLng(latlng) {
  if (activeDrawMode === "rectangle") {
    if (!rectangleStartLatLng) {
      rectangleStartLatLng = latlng;
      setDrawStatus("図形描画: 矩形の2点目をクリックしてください。");
      return true;
    }

    closeShapeNameEditor();
    clearDrawPreview();
    const rectangle = L.rectangle(
      L.latLngBounds(rectangleStartLatLng, latlng),
      SHAPE_STYLE,
    );
    rectangle.shapeStyle = buildShapeStyleFromColor(
      "rectangle",
      getSelectedShapeColor(),
    );

    saveShape("rectangle", rectangle, getShapeNameInputValue())
      .then(() => {
        clearShapeNameInput();
        resetDrawingState("図形描画: オフ");
      })
      .catch(() => {
        resetDrawingState("図形描画: 保存に失敗しました。", true);
      });
    return true;
  }

  if (activeDrawMode === "circle") {
    if (!circleStartLatLng) {
      circleStartLatLng = latlng;
      setDrawStatus("図形描画: 円周上の点をクリックしてください。");
      return true;
    }

    completeCircleDrawing(latlng);
    return true;
  }

  if (activeDrawMode === "polyline" || activeDrawMode === "polygon") {
    closeShapeNameEditor();
    drawPoints.push(latlng);
    setDrawStatus(`図形描画: ${drawPoints.length} 点を追加しました。`);
    return true;
  }

  if (activeDrawMode === "delete") {
    return true;
  }

  return false;
}

// 地図クリック時にサーバーに情報を送信しマーカー描画
map.on("click", async function (e) {
  if (isPropagatedMapClickSuppressed(e)) {
    return;
  }

  if (isMapClickSuppressed()) {
    return;
  }

  if (activeDrawMode === "delete") {
    await deleteShapeAtLatLng(e.latlng);
    return;
  }

  if (handleShapeDrawLatLng(e.latlng)) {
    return;
  }

  if (tryAddShapeVertexAtLatLng(e)) {
    return;
  }

  // ラジオボタンの状態を確認
  let isInputMode = document.getElementById("inputMode").checked;
  // 閲覧モードの場合は何もしない
  if (!isInputMode) {
    return;
  }

  // fetchを使用してサーバーにPOSTリクエストを送る
  let url = `/marker?layer_id=${layer}&latitude=${e.latlng.lat}&longitude=${e.latlng.lng}`;
  // fetchを使用してサーバーにPOSTリクエストを送る
  fetchWithAuth(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
  })
    .then((response) => {
      if (!response.ok) {
        throw new Error("Network response was not ok");
      }
      return response.json(); // 必要に応じて JSON 形式でレスポンスを受け取る
    })
    .then((data) => {
      // サーバーからid, 緯度, 経度を受け取りマーカーとして描画
      var marker = L.marker(
        e.latlng,
        markerOptionsForLayer(layer, layersFromAxum, { draggable: false }),
      )
        .addTo(markersClusterGroup)
        .on("dragend", function (event) {
          var movedMarker = event.target;
          var position = movedMarker.getLatLng();
          updateServer(movedMarker.id, position.lat, position.lng);
        });
      marker.id = data["id"];
      const markerKey = `marker-${data["id"]}`;
      const markerElement = marker.getElement();
      if (markerElement) {
        markerElement.id = markerKey;
      }
      markers[markerKey] = marker;
      markersFromAxum[data["id"]] = {
        id: data["id"],
        layer_id: layer,
        marker_name: "",
        latitude: e.latlng.lat,
        longitude: e.latlng.lng,
        detail: "",
      };

      // 再描画用の管理データへ登録してから、親画面の一覧を更新する
      callParentReload();
    })
    .catch((error) => {
      console.error(
        "There was a problem with the fetch operation:",
        error.message,
      );
    });
});

function updateDrawPreviewForLatLng(latlng) {
  if (!activeDrawMode || !latlng) {
    return;
  }

  if (activeDrawMode === "rectangle") {
    if (!rectangleStartLatLng) {
      return;
    }
    updateExistingPreviewLayer("rectangle", [latlng]);
    return;
  }

  if (activeDrawMode === "circle") {
    if (!circleStartLatLng) {
      return;
    }
    updateExistingPreviewLayer("circle", [latlng]);
    return;
  }

  if (activeDrawMode === "delete" || drawPoints.length === 0) {
    return;
  }

  const previewLatLngs = [...drawPoints, latlng];
  updateExistingPreviewLayer(activeDrawMode, previewLatLngs);
}

map.on("mousemove", function (e) {
  updateDrawPreviewForLatLng(e.latlng);
});

map.on("touchmove", function (e) {
  if (!activeDrawMode) {
    return;
  }
  if (e.originalEvent) {
    L.DomEvent.preventDefault(e.originalEvent);
  }
  updateDrawPreviewForLatLng(getLatLngFromTouchEvent(e));
});

map.on("touchend", async function (e) {
  if (!activeDrawMode || isTouchEndSuppressed()) {
    return;
  }
  const latlng = getLatLngFromTouchEvent(e);
  if (!latlng) {
    return;
  }
  if (e.originalEvent) {
    L.DomEvent.stop(e.originalEvent);
  }
  suppressNextMapClick();
  if (activeDrawMode === "delete") {
    await deleteShapeAtLatLng(latlng);
    return;
  }
  handleShapeDrawLatLng(latlng);
});

document.addEventListener("keydown", async (event) => {
  if (event.key !== "Escape" || event.isComposing || !activeDrawMode) {
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  await completeActiveDrawing();
});

function installPenPointerDrawingHandlers() {
  if (!window.PointerEvent) {
    return;
  }

  const mapContainer = map.getContainer();
  if (!mapContainer) {
    return;
  }

  mapContainer.addEventListener(
    "pointerdown",
    (event) => {
      if (!isPenPointerEvent(event) || !isPenOptimizedDrawMode()) {
        return;
      }
      activePenPointerId = event.pointerId;
      mapContainer.setPointerCapture?.(event.pointerId);
      suppressNextMapClick();
      suppressNextTouchEnd();
      stopNativeDrawingEvent(event);
    },
    true,
  );

  mapContainer.addEventListener(
    "pointermove",
    (event) => {
      if (!isPenPointerEvent(event) || !isPenOptimizedDrawMode()) {
        return;
      }
      if (
        activePenPointerId !== null &&
        event.pointerId !== activePenPointerId
      ) {
        return;
      }
      const latlng = getLatLngFromPointerEvent(event);
      if (!latlng) {
        return;
      }
      suppressNextMapClick();
      suppressNextTouchEnd();
      stopNativeDrawingEvent(event);
      updateDrawPreviewForLatLng(latlng);
    },
    true,
  );

  mapContainer.addEventListener(
    "pointerup",
    (event) => {
      if (!isPenPointerEvent(event) || !isPenOptimizedDrawMode()) {
        activePenPointerId = null;
        return;
      }
      if (
        activePenPointerId !== null &&
        event.pointerId !== activePenPointerId
      ) {
        return;
      }
      const latlng = getLatLngFromPointerEvent(event);
      activePenPointerId = null;
      mapContainer.releasePointerCapture?.(event.pointerId);
      if (!latlng) {
        return;
      }
      suppressNextMapClick();
      suppressNextTouchEnd();
      stopNativeDrawingEvent(event);
      handleShapeDrawLatLng(latlng);
    },
    true,
  );

  mapContainer.addEventListener(
    "pointercancel",
    (event) => {
      if (isPenPointerEvent(event) && event.pointerId === activePenPointerId) {
        activePenPointerId = null;
        mapContainer.releasePointerCapture?.(event.pointerId);
      }
    },
    true,
  );
}

installPenPointerDrawingHandlers();

// 座標検索
var CodeSearchControl = L.Control.extend({
  options: {
    position: "topleft",
  },

  onAdd: function (map) {
    var container = L.DomUtil.create("div", "leaflet-bar leaflet-control");
    // ラジオボタンのHTMLを作成
    container.innerHTML = `
        <div class="search-zone">
            <input type="text" class="search-input" id="code-input" placeholder="緯度,経度" title="緯度経度を,区切りで入力してください。"><br>
            <button id="code-search-btn" class="custom-search">座標検索</button>
        </div>`;

    const searchBtn = container.querySelector(".custom-search");
    // ボタンのクリックイベント
    L.DomEvent.on(searchBtn, "click", function (e) {
      L.DomEvent.stop(e);
      onSearchCode();
    });

    // Leafletのクリックイベントとの干渉を避ける
    L.DomEvent.disableClickPropagation(container);
    return container;
  },
});

// 緯度経度入力から対象地点へフォーカスする
// 緯度経度が妥当な数値範囲かを判定する
// 地図にカスタムコントロールを追加
map.addControl(new CodeSearchControl());

const userLocationLayer = initializeUserLocation(map, { position: "topright" });
if (userLocationLayer && !getInitialUserLocationVisibility()) {
  map.removeLayer(userLocationLayer);
}

// 図形描画コントロールの定義
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

map.addControl(new DrawShapeControl());
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

map.addControl(new MeasurementVisibleControl());

// 指定地点へ地図を移動し、必要ならマーカーを強調表示する
