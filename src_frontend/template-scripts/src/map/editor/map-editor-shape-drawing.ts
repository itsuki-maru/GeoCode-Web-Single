// @ts-nocheck -- Leaflet編集画面の共有スコープを保つ統合境界。
async function saveShape(
  shapeType,
  layer,
  shapeName = "",
  forcedLayerId = null,
) {
  const targetLayerId = forcedLayerId || getCurrentShapeLayerId();
  if (!targetLayerId) {
    throw new Error("shape layer missing");
  }
  const nextShapeStyle =
    layer.shapeStyle ||
    buildShapeStyleFromColor(shapeType, getSelectedShapeColor());
  const nextGeoJson = buildShapeGeoJson(layer, shapeType, nextShapeStyle);

  const response = await fetchWithAuth("/shape", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      layer_id: targetLayerId,
      shape_type: shapeType,
      name: shapeName,
      geojson: nextGeoJson,
    }),
  });

  if (!response.ok) {
    throw new Error("shape save failed");
  }

  const data = await response.json();
  applyShapeRecord(layer, {
    id: data.id,
    layer_id: targetLayerId,
    shape_type: shapeType,
    name: shapeName,
    geojson: nextGeoJson,
  });
  applyShapeStyle(layer, activeDrawMode === "delete");
  updateShapeNameLabel(layer, shapeName);
  attachShapeEvents(layer);
  drawnShapesGroup.addLayer(layer);
  renderVisibleShapes();
  if (!map.hasLayer(drawnShapesGroup)) {
    drawnShapesGroup.addTo(map);
  }
  applyMeasurementVisibilityToDrawnShapesGroup();
  setDrawStatus("図形描画: 保存しました。");
  if (!editorEntryProfile.isMobile) callParentReload();
}

// 直前に削除した図形を同じレイヤへ再作成する
async function undoDeletedShape() {
  if (deletedShapesStack.length === 0) {
    setDrawStatus("図形描画: 元に戻せる図形はありません。", true);
    return;
  }

  const deletedShape = deletedShapesStack.pop();
  updateUndoButtonState();

  const restoredLayer = createShapeLayer(
    deletedShape.shapeType,
    deletedShape.geojson,
    deletedShape.name || "",
  );
  if (!restoredLayer) {
    deletedShapesStack.push(deletedShape);
    updateUndoButtonState();
    setDrawStatus("図形描画: 図形の復元に失敗しました。", true);
    return;
  }

  try {
    await saveShape(
      deletedShape.shapeType,
      restoredLayer,
      deletedShape.name || "",
      deletedShape.layerId,
    );
    setDrawStatus("図形描画: 削除した図形を復元しました。");
  } catch (_error) {
    deletedShapesStack.push(deletedShape);
    updateUndoButtonState();
    setDrawStatus("図形描画: 復元に失敗しました。", true);
  }
}

// 折れ線またはポリゴンの描画を確定して保存する
async function completeLineOrPolygon() {
  const shapeName = getShapeNameInputValue();
  if (activeDrawMode === "polyline") {
    if (drawPoints.length < 2) {
      setDrawStatus("図形描画: 線は2点以上必要です。", true);
      return;
    }
    const shapeLayer = L.polyline(drawPoints, SHAPE_STYLE);
    shapeLayer.shapeStyle = buildShapeStyleFromColor(
      "polyline",
      getSelectedShapeColor(),
    );
    try {
      await saveShape("polyline", shapeLayer, shapeName);
      clearShapeNameInput();
      resetDrawingState("図形描画: オフ");
    } catch (_error) {
      resetDrawingState("図形描画: 保存に失敗しました。", true);
    }
    return;
  }

  if (activeDrawMode === "polygon") {
    if (drawPoints.length < 3) {
      setDrawStatus("図形描画: 面は3点以上必要です。", true);
      return;
    }
    const shapeLayer = L.polygon(drawPoints, SHAPE_STYLE);
    shapeLayer.shapeStyle = buildShapeStyleFromColor(
      "polygon",
      getSelectedShapeColor(),
    );
    try {
      await saveShape("polygon", shapeLayer, shapeName);
      clearShapeNameInput();
      resetDrawingState("図形描画: オフ");
    } catch (_error) {
      resetDrawingState("図形描画: 保存に失敗しました。", true);
    }
  }
}

// 現在の描画モードに応じて「完了」と同じ処理を実行する
async function completeActiveDrawing() {
  if (isCompletingActiveDrawing) {
    return;
  }
  if (activeDrawMode === "rectangle" || activeDrawMode === "circle") {
    const shapeLabel = activeDrawMode === "circle" ? "円" : "矩形";
    setDrawStatus(
      `図形描画: ${shapeLabel}は2点目を${editorEntryProfile.interactionVerb}すると保存されます。`,
      true,
    );
    return;
  }
  if (activeDrawMode === "delete") {
    setDrawStatus(
      `図形描画: 削除モードでは図形を${editorEntryProfile.interactionVerb}してください。`,
      true,
    );
    return;
  }
  if (!activeDrawMode) {
    setDrawStatus("図形描画: モードを選択してください。", true);
    return;
  }
  isCompletingActiveDrawing = true;
  try {
    await completeLineOrPolygon();
  } finally {
    isCompletingActiveDrawing = false;
  }
}

// 円の描画を確定して保存する
function completeCircleDrawing(targetLatLng) {
  if (!circleStartLatLng) {
    setDrawStatus(
      `図形描画: 円の中心を${editorEntryProfile.interactionVerb}してください。`,
      true,
    );
    return;
  }

  const radius = map.distance(circleStartLatLng, targetLatLng);
  if (!(radius > 0)) {
    setDrawStatus(
      `図形描画: 半径が0より大きくなる位置を${editorEntryProfile.interactionVerb}してください。`,
      true,
    );
    return;
  }

  closeShapeNameEditor();
  clearDrawPreview();
  const circle = L.circle(circleStartLatLng, {
    ...SHAPE_STYLE,
    radius,
  });
  circle.shapeStyle = buildShapeStyleFromColor(
    "circle",
    getSelectedShapeColor(),
  );

  saveShape("circle", circle, getShapeNameInputValue())
    .then(() => {
      clearShapeNameInput();
      resetDrawingState("図形描画: オフ");
    })
    .catch(() => {
      resetDrawingState("図形描画: 保存に失敗しました。", true);
    });
}

// ポップアップを開く関数
// 指定 ID のマーカーポップアップを開く

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
      setDrawStatus(
        `図形描画: 矩形の2点目を${editorEntryProfile.interactionVerb}してください。`,
      );
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
      setDrawStatus(
        `図形描画: 円周上の点を${editorEntryProfile.interactionVerb}してください。`,
      );
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
      const markerKey = `marker-${data["id"]}`;
      marker.id = data["id"];
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
      const logError = editorEntryProfile.isMobile
        ? console.log
        : console.error;
      logError("There was a problem with the fetch operation:", error.message);
    });
});

// ポインター位置に合わせて描画プレビューを更新する
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

// ツールチップの制御
