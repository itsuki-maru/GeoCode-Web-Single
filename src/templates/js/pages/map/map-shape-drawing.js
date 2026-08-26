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
  callParentReload();
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
      `図形描画: ${shapeLabel}は2点目をクリックすると保存されます。`,
      true,
    );
    return;
  }
  if (activeDrawMode === "delete") {
    setDrawStatus("図形描画: 削除モードでは図形をクリックしてください。", true);
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
    setDrawStatus("図形描画: 円の中心をクリックしてください。", true);
    return;
  }

  const radius = map.distance(circleStartLatLng, targetLatLng);
  if (!(radius > 0)) {
    setDrawStatus(
      "図形描画: 半径が0より大きくなる位置をクリックしてください。",
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

// ツールチップの制御
