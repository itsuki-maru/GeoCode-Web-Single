const drawnShapesGroup = L.featureGroup();
const searchableShapeLayers = new Set();
let shapeNameLabelManager = null;
let shapeMeasurementManager = null;

const mapEditorProfile = Object.freeze({
  bindPolylineHoverHighlight: false,
  isShapeVisibleForMeasurement: (layer) => isShapeVisibleForSearch(layer),
  shouldSuppressShapeLabelClick: () => false,
});

const SHAPE_STYLE = {
  color: "#d94841",
  weight: 5,
  fillColor: "#d94841",
  fillOpacity: 0.16,
};
const DELETE_SHAPE_STYLE = {
  color: "#c1121f",
  weight: 8,
  fillColor: "#f28482",
  fillOpacity: 0.28,
};
const DELETE_HIT_TOLERANCE_PX = 18;
const MEASUREMENT_SEGMENT_LABEL_GROUP_SIZE = 2;
const SHAPE_VERTEX_ADD_TOLERANCE_PX = 24;
const SHAPE_VERTEX_MIN_DISTANCE_PX = 16;
const shapeGeometryEditHandles = L.featureGroup();
let currentMapMode = "view";
let geometryEditingShapeLayer = null;
let isShapeGeometrySaving = false;
let circleShapeDragState = null;
let drawStatusAutoHideTimer = null;

let activeDrawMode = null;
let isCompletingActiveDrawing = false;
let drawPoints = [];
let drawPreviewLayer = null;
let rectangleStartLatLng = null;
let circleStartLatLng = null;
let deletedShapesStack = [];
let editingShapeLayer = null;
let editingShapePopup = null;
let shapeVertexDeletePopup = null;
let shapeVertexDeleteTarget = null;
let suppressMapClickUntil = 0;
let suppressedPropagatedMapClickEvent = null;
let suppressTouchEndUntil = 0;
let activePenPointerId = null;
let isMeasurementVisible = false;
let isMeasurementSegmentMerged = false;
let drawingInteractionState = null;
const deletingShapeIds = new Set();
const deletedShapeIds = new Set();

// 図形描画用のステータスメッセージを更新する
function setDrawStatus(message, isError = false, forceVisible = false) {
  const status = document.getElementById("draw-status");
  if (!status) {
    return;
  }
  if (drawStatusAutoHideTimer) {
    clearTimeout(drawStatusAutoHideTimer);
    drawStatusAutoHideTimer = null;
  }
  status.textContent = message;
  status.classList.toggle("is-error", isError);
  if (!forceVisible) {
    const panel = document.getElementById("draw-control-panel");
    status.classList.toggle(
      "is-hidden",
      !panel || panel.classList.contains("is-collapsed"),
    );
    return;
  }

  status.classList.remove("is-hidden");
  drawStatusAutoHideTimer = setTimeout(() => {
    const panel = document.getElementById("draw-control-panel");
    if (!panel || panel.classList.contains("is-collapsed")) {
      status.classList.add("is-hidden");
    }
    drawStatusAutoHideTimer = null;
  }, 4000);
}

// ラベルやポップアップ表示用に HTML をエスケープする
// 図形名を表示・保存しやすい形に正規化する
// 図形色を #RRGGBB 形式へ正規化する
// 図形種別ごとの既定スタイルを返す
// GeoJSON から図形スタイルを取り出す
// 選択色から図形スタイルを作る
function buildShapeStyleFromColor(
  shapeType,
  color,
  lineType = "solid",
  weight = SHAPE_STYLE.weight,
  arrowType = "none",
) {
  const normalizedColor = normalizeShapeColor(color, SHAPE_STYLE.color);
  const defaultStyle = getDefaultShapeStyle(shapeType);
  const dashArray = getShapeDashArray(lineType);
  const normalizedWeight = normalizeShapeWeight(weight, defaultStyle.weight);
  if (shapeType === "polyline") {
    return {
      color: normalizedColor,
      weight: normalizedWeight,
      dashArray,
      arrowType: normalizeShapeArrowType(arrowType),
      fill: false,
    };
  }

  return {
    color: normalizedColor,
    weight: normalizedWeight,
    dashArray,
    fillColor: normalizedColor,
    fillOpacity: defaultStyle.fillOpacity,
  };
}

// 図形レイヤから保存用 GeoJSON を組み立てる
function buildShapeGeoJson(
  layer,
  shapeType,
  shapeStyle,
  shapeMemo = layer?.shapeMemo,
) {
  const geojson = layer.toGeoJSON();
  const normalizedStyle = {
    color: normalizeShapeColor(shapeStyle?.color, SHAPE_STYLE.color),
    weight: normalizeShapeWeight(shapeStyle?.weight, SHAPE_STYLE.weight),
    dashArray: normalizeShapeDashArray(shapeStyle?.dashArray),
  };

  if (shapeType === "polyline") {
    normalizedStyle.arrowType = normalizeShapeArrowType(shapeStyle?.arrowType);
  } else {
    normalizedStyle.fillColor = normalizeShapeColor(
      shapeStyle?.color,
      normalizedStyle.color,
    );
    normalizedStyle.fillOpacity = Number.isFinite(
      Number(shapeStyle?.fillOpacity),
    )
      ? Number(shapeStyle.fillOpacity)
      : SHAPE_STYLE.fillOpacity;
  }

  geojson.properties = {
    ...(geojson.properties && typeof geojson.properties === "object"
      ? geojson.properties
      : {}),
    style: normalizedStyle,
    memo: normalizeShapeMemo(shapeMemo),
  };
  if (shapeType === "circle") {
    const radius = Number(layer?.getRadius?.());
    if (Number.isFinite(radius) && radius > 0) {
      geojson.properties.radius = radius;
    }
  }
  return geojson;
}

// GeoJSON に保存された半径を取り出す
// 選択中の図形色を取得する
function getSelectedShapeColor() {
  const input = document.getElementById("draw-shape-color");
  return normalizeShapeColor(input?.value, SHAPE_STYLE.color);
}

// 現在の図形色入力欄へ色を反映する
function setSelectedShapeColor(color) {
  const input = document.getElementById("draw-shape-color");
  if (!input) {
    return;
  }
  input.value = normalizeShapeColor(color, SHAPE_STYLE.color);
}

// 図形名入力欄の現在値を取得する
function getShapeNameInputValue() {
  const input = document.getElementById("draw-shape-name");
  if (!input) {
    return "";
  }
  return normalizeShapeName(input.value);
}

// 図形名入力欄をクリアする
function clearShapeNameInput() {
  const input = document.getElementById("draw-shape-name");
  if (input) {
    input.value = "";
  }
}

// 開いている図形名編集ポップアップを閉じる
function closeShapeNameEditor() {
  if (editingShapePopup) {
    map.closePopup(editingShapePopup);
  }
  editingShapePopup = null;
  editingShapeLayer = null;
}

// 開いている頂点削除確認ポップアップを閉じる
function closeShapeVertexDeletePopup() {
  const popup = shapeVertexDeletePopup;
  shapeVertexDeletePopup = null;
  shapeVertexDeleteTarget = null;
  if (popup && map.hasLayer(popup)) {
    map.closePopup(popup);
  }
}

// 描画途中のプレビュー図形を地図上から取り除く
function clearDrawPreview() {
  if (drawPreviewLayer) {
    map.removeLayer(drawPreviewLayer);
    drawPreviewLayer = null;
  }
}

// タッチ描画中だけ地図操作を止め、指の移動を図形プレビューに集中させる
function setDrawingMapInteractionsDisabled(shouldDisable) {
  if (shouldDisable && !drawingInteractionState) {
    drawingInteractionState = {
      dragging: Boolean(map.dragging?.enabled?.()),
      touchZoom: Boolean(map.touchZoom?.enabled?.()),
      doubleClickZoom: Boolean(map.doubleClickZoom?.enabled?.()),
      boxZoom: Boolean(map.boxZoom?.enabled?.()),
    };
    map.dragging?.disable?.();
    map.touchZoom?.disable?.();
    map.doubleClickZoom?.disable?.();
    map.boxZoom?.disable?.();
    return;
  }

  if (!shouldDisable && drawingInteractionState) {
    if (drawingInteractionState.dragging) {
      map.dragging?.enable?.();
    }
    if (drawingInteractionState.touchZoom) {
      map.touchZoom?.enable?.();
    }
    if (drawingInteractionState.doubleClickZoom) {
      map.doubleClickZoom?.enable?.();
    }
    if (drawingInteractionState.boxZoom) {
      map.boxZoom?.enable?.();
    }
    drawingInteractionState = null;
  }
}

function updateShapeDrawingState() {
  const mapContainer = map.getContainer();
  if (mapContainer) {
    mapContainer.classList.toggle("is-shape-drawing", Boolean(activeDrawMode));
    mapContainer.classList.toggle(
      "is-shape-delete",
      activeDrawMode === "delete",
    );
  }
  setDrawingMapInteractionsDisabled(Boolean(activeDrawMode));
}

function suppressNextMapClick(durationMs = 700) {
  suppressMapClickUntil = Date.now() + durationMs;
}

function isMapClickSuppressed() {
  if (Date.now() >= suppressMapClickUntil) {
    return false;
  }
  suppressMapClickUntil = 0;
  return true;
}

// Leaflet 内部で地図へ伝播する操作済みクリックのうち、その同一イベントだけを無視する
function suppressPropagatedMapClick(event) {
  if (event?.type !== "click" || !event.originalEvent) {
    return;
  }

  const originalEvent = event.originalEvent;
  suppressedPropagatedMapClickEvent = originalEvent;
  setTimeout(() => {
    if (suppressedPropagatedMapClickEvent === originalEvent) {
      suppressedPropagatedMapClickEvent = null;
    }
  }, 0);
}

function isPropagatedMapClickSuppressed(event) {
  if (
    !suppressedPropagatedMapClickEvent ||
    event?.originalEvent !== suppressedPropagatedMapClickEvent
  ) {
    return false;
  }

  suppressedPropagatedMapClickEvent = null;
  return true;
}

function suppressNextTouchEnd(durationMs = 700) {
  suppressTouchEndUntil = Date.now() + durationMs;
}

function isTouchEndSuppressed() {
  return Date.now() < suppressTouchEndUntil;
}

function getLatLngFromTouchEvent(event) {
  if (event.latlng) {
    return event.latlng;
  }

  const originalEvent = event.originalEvent;
  const touch =
    originalEvent?.changedTouches?.[0] || originalEvent?.touches?.[0];
  if (!touch) {
    return null;
  }

  const containerPoint = map.mouseEventToContainerPoint(touch);
  return map.containerPointToLatLng(containerPoint);
}

function isPenPointerEvent(event) {
  return event?.pointerType === "pen";
}

function isPenOptimizedDrawMode() {
  return Boolean(activeDrawMode && activeDrawMode !== "delete");
}

function getLatLngFromPointerEvent(event) {
  if (!event) {
    return null;
  }
  const containerPoint = map.mouseEventToContainerPoint(event);
  return map.containerPointToLatLng(containerPoint);
}

function stopNativeDrawingEvent(event) {
  event.preventDefault?.();
  event.stopPropagation?.();
  event.stopImmediatePropagation?.();
}

function updateExistingPreviewLayer(mode, latLngs) {
  const previewStyle = {
    ...buildShapeStyleFromColor(mode, getSelectedShapeColor()),
    dashArray: "6,4",
  };

  if (mode === "rectangle") {
    if (!rectangleStartLatLng || !latLngs?.[0]) {
      return;
    }
    const bounds = L.latLngBounds(rectangleStartLatLng, latLngs[0]);
    if (
      drawPreviewLayer?.previewMode === "rectangle" &&
      typeof drawPreviewLayer.setBounds === "function"
    ) {
      drawPreviewLayer.setBounds(bounds);
      drawPreviewLayer.setStyle(previewStyle);
      return;
    }
    clearDrawPreview();
    drawPreviewLayer = L.rectangle(bounds, previewStyle).addTo(map);
    drawPreviewLayer.previewMode = "rectangle";
    return;
  }

  if (mode === "circle") {
    if (!circleStartLatLng || !latLngs?.[0]) {
      return;
    }
    const radius = map.distance(circleStartLatLng, latLngs[0]);
    if (!(radius > 0)) {
      return;
    }
    if (
      drawPreviewLayer?.previewMode === "circle" &&
      typeof drawPreviewLayer.setRadius === "function"
    ) {
      drawPreviewLayer.setLatLng(circleStartLatLng);
      drawPreviewLayer.setRadius(radius);
      drawPreviewLayer.setStyle(previewStyle);
      return;
    }
    clearDrawPreview();
    drawPreviewLayer = L.circle(circleStartLatLng, {
      ...previewStyle,
      radius,
    }).addTo(map);
    drawPreviewLayer.previewMode = "circle";
    return;
  }

  if (
    drawPreviewLayer?.previewMode === mode &&
    typeof drawPreviewLayer.setLatLngs === "function"
  ) {
    drawPreviewLayer.setLatLngs(latLngs);
    drawPreviewLayer.setStyle(previewStyle);
    return;
  }
  clearDrawPreview();
  drawPreviewLayer = createPreviewLayer(mode, latLngs).addTo(map);
  drawPreviewLayer.previewMode = mode;
}

// 現在の描画モードに応じてボタン状態を更新する
function updateDrawButtons(container) {
  const buttons = container.querySelectorAll("[data-draw-mode]");
  buttons.forEach((button) => {
    button.classList.toggle(
      "is-active",
      button.dataset.drawMode === activeDrawMode,
    );
  });
}

// Undo ボタンの活性状態をスタックに合わせて更新する
function updateUndoButtonState() {
  const undoButton = document.getElementById("draw-undo-btn");
  if (!undoButton) {
    return;
  }
  undoButton.disabled = deletedShapesStack.length === 0;
}

// 図形ツールパネルの開閉状態を切り替える
function toggleDrawPanel(forceExpanded = null) {
  const panel = document.getElementById("draw-control-panel");
  const toggleButton = document.getElementById("draw-toggle-btn");
  const status = document.getElementById("draw-status");
  if (!panel || !toggleButton) {
    return;
  }

  const shouldExpand =
    forceExpanded === null
      ? panel.classList.contains("is-collapsed")
      : forceExpanded;

  panel.classList.toggle("is-collapsed", !shouldExpand);
  toggleButton.textContent = shouldExpand ? "図形ツールを閉じる" : "図形ツール";
  if (status) {
    status.classList.toggle("is-hidden", !shouldExpand);
  }
}

// 通常時と削除モードで図形スタイルを切り替える
function applyShapeStyle(layer, isDeleteMode = false) {
  if (!layer || typeof layer.setStyle !== "function") {
    return;
  }

  const style = isDeleteMode
    ? DELETE_SHAPE_STYLE
    : layer.shapeStyle || getDefaultShapeStyle(layer.shapeType);
  const nextStyle = { ...style };
  if (layer.shapeType === "polyline" || isDeleteMode) {
    nextStyle.fill = false;
  }
  layer.setStyle(nextStyle);
  bindShapeArrowStyle(layer);
  applyShapeArrowStyle(layer);
}

// すでに描画済みの図形へ現在モードの見た目を反映する
function updateShapesInteractionStyle() {
  const measurementLayers = [];

  drawnShapesGroup.eachLayer((layer) => {
    if (layer?.isMeasurementLabel === true) {
      measurementLayers.push(layer);
      return;
    }
    applyShapeStyle(layer, activeDrawMode === "delete");
    if (
      activeDrawMode === "delete" &&
      typeof layer.bringToFront === "function"
    ) {
      layer.bringToFront();
    }
  });

  measurementLayers.forEach((layer) => {
    if (typeof layer.bringToFront === "function") {
      layer.bringToFront();
    }
  });
}

// 描画中の内部状態を初期化して通常状態へ戻す
function resetDrawingState(message = "図形描画: オフ", isError = false) {
  activeDrawMode = null;
  activePenPointerId = null;
  drawPoints = [];
  rectangleStartLatLng = null;
  circleStartLatLng = null;
  clearDrawPreview();
  updateShapeDrawingState();
  updateShapesInteractionStyle();
  setDrawStatus(message, isError);
  const drawControl = document.getElementById("draw-control");
  if (drawControl) {
    updateDrawButtons(drawControl);
  }
}

// 指定モードで図形描画を開始する
function beginDrawing(mode) {
  closeShapeNameEditor();
  clearShapeGeometryEditing();
  toggleDrawPanel(true);
  activeDrawMode = mode;
  drawPoints = [];
  rectangleStartLatLng = null;
  circleStartLatLng = null;
  clearDrawPreview();
  updateShapeDrawingState();
  if (mode === "rectangle") {
    setDrawStatus("図形描画: 矩形の1点目をタップしてください。");
  } else if (mode === "circle") {
    setDrawStatus("図形描画: 円の中心をタップしてください。");
  } else if (mode === "delete") {
    setDrawStatus("図形描画: 削除したい図形をタップしてください。");
  } else if (mode === "polyline") {
    setDrawStatus("図形描画: 線の頂点をタップし、完了を押してください。");
  } else {
    setDrawStatus("図形描画: 面の頂点をタップし、完了を押してください。");
  }
  updateShapesInteractionStyle();
  const drawControl = document.getElementById("draw-control");
  if (drawControl) {
    updateDrawButtons(drawControl);
  }
}

// 描画途中のプレビュー用レイヤを生成する
function createPreviewLayer(mode, latLngs) {
  const previewStyle = {
    ...buildShapeStyleFromColor(mode, getSelectedShapeColor()),
    dashArray: "6,4",
  };
  if (mode === "polyline") {
    return L.polyline(latLngs, previewStyle);
  }
  if (mode === "circle") {
    if (!Array.isArray(latLngs) || latLngs.length < 2) {
      return null;
    }
    const radius = map.distance(latLngs[0], latLngs[latLngs.length - 1]);
    if (!(radius > 0)) {
      return null;
    }
    return L.circle(latLngs[0], {
      ...previewStyle,
      radius,
    });
  }
  return L.polygon(latLngs, previewStyle);
}

// Leaflet の座標配列をラベル計算しやすい一次元配列へ平坦化する
