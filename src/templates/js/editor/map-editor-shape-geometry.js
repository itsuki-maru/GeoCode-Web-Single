function cloneShapeLatLngs(latLngs) {
  if (Array.isArray(latLngs)) {
    return latLngs.map((value) => cloneShapeLatLngs(value));
  }
  if (latLngs && Number.isFinite(latLngs.lat) && Number.isFinite(latLngs.lng)) {
    return L.latLng(latLngs.lat, latLngs.lng, latLngs.alt);
  }
  return latLngs;
}

// 図形編集開始時の形状を保存用スナップショットとして取得する
function captureShapeGeometry(layer) {
  if (layer?.shapeType === "circle" && typeof layer.getLatLng === "function") {
    return {
      center: cloneShapeLatLngs(layer.getLatLng()),
      radius: layer.getRadius(),
    };
  }
  return {
    latLngs: cloneShapeLatLngs(layer?.getLatLngs?.() || []),
  };
}

// 保存失敗や編集キャンセル時に図形を元の位置へ戻す
function restoreShapeGeometry(layer, snapshot) {
  if (!layer || !snapshot) {
    return;
  }
  if (layer.shapeType === "circle" && snapshot.center) {
    layer.setLatLng(snapshot.center);
    if (Number.isFinite(snapshot.radius) && snapshot.radius > 0) {
      layer.setRadius(snapshot.radius);
    }
    return;
  }
  if (snapshot.latLngs && typeof layer.setLatLngs === "function") {
    layer.setLatLngs(cloneShapeLatLngs(snapshot.latLngs));
  }
}

// 図形の移動に合わせて名前ラベルと計測ラベルを更新する
function refreshShapeGeometryPresentation(layer) {
  const tooltip = layer?.getTooltip?.();
  const labelLatLng = getShapeLabelLatLng(layer);
  if (tooltip && labelLatLng && typeof tooltip.setLatLng === "function") {
    tooltip.setLatLng(labelLatLng);
  }
  refreshShapeMeasurementMarkers(layer);
}

// 選択図形の強調クラスを SVG パスへ付け外しする
function setShapeGeometrySelectedStyle(layer, isSelected) {
  const element = layer?.getElement?.();
  if (element) {
    element.classList.toggle("is-shape-geometry-selected", isSelected);
  }
}

// 編集ハンドルを保存中だけ操作不可にする
function setShapeGeometryHandlesEnabled(isEnabled) {
  shapeGeometryEditHandles.eachLayer((handle) => {
    if (!handle?.dragging) {
      return;
    }
    if (isEnabled) {
      handle.dragging.enable();
    } else {
      handle.dragging.disable();
    }
  });
}

// 円ドラッグ用の document イベントを解除し、地図操作を復元する
function releaseCircleShapeDragInteractions() {
  document.removeEventListener("mousemove", handleCircleShapeDragMove, true);
  document.removeEventListener("mouseup", handleCircleShapeDragEnd, true);
  document.removeEventListener("touchmove", handleCircleShapeDragMove, true);
  document.removeEventListener("touchend", handleCircleShapeDragEnd, true);
  document.removeEventListener("touchcancel", handleCircleShapeDragEnd, true);
  map.getContainer()?.classList.remove("is-shape-geometry-dragging");
  if (circleShapeDragState?.mapDraggingWasEnabled) {
    map.dragging.enable();
  }
}

// モード変更などで円ドラッグが中断された場合は開始位置へ戻す
function cancelActiveCircleShapeDrag() {
  if (!circleShapeDragState) {
    return;
  }
  const { layer, snapshot } = circleShapeDragState;
  restoreShapeGeometry(layer, snapshot);
  refreshShapeGeometryPresentation(layer);
  releaseCircleShapeDragInteractions();
  circleShapeDragState = null;
}

// 図形編集の選択状態と頂点ハンドルをすべて解除する
function clearShapeGeometryEditing() {
  cancelActiveCircleShapeDrag();
  closeShapeVertexDeletePopup();
  setShapeGeometrySelectedStyle(geometryEditingShapeLayer, false);
  geometryEditingShapeLayer = null;
  shapeGeometryEditHandles.clearLayers();
  if (map.hasLayer(shapeGeometryEditHandles)) {
    map.removeLayer(shapeGeometryEditHandles);
  }
}

// 編集後の GeoJSON を既存の図形更新 API へ保存する
async function persistShapeGeometryEdit(layer, snapshot, options = {}) {
  if (!layer?.shapeId || isShapeGeometrySaving) {
    return;
  }
  const nextShapeType = options.shapeType || layer.shapeType;
  const targetLayerId =
    layer.layerId ||
    layer.options?.shapeRecord?.layer_id ||
    getCurrentShapeLayerId();
  if (!targetLayerId) {
    restoreShapeGeometry(layer, snapshot);
    refreshShapeGeometryPresentation(layer);
    setDrawStatus("図形編集: 所属レイヤを取得できませんでした。", true);
    return;
  }

  isShapeGeometrySaving = true;
  closeShapeVertexDeletePopup();
  setShapeGeometryHandlesEnabled(false);
  try {
    const nextGeoJson = buildShapeGeoJson(
      layer,
      nextShapeType,
      layer.shapeStyle || getDefaultShapeStyle(nextShapeType),
    );
    await persistShapeMetadata(
      layer,
      normalizeShapeName(layer.shapeName || ""),
      targetLayerId,
      nextGeoJson,
      options.shapeType || null,
    );
    applyShapeRecord(layer, {
      id: layer.shapeId,
      layer_id: targetLayerId,
      shape_type: nextShapeType,
      name: layer.shapeName || "",
      geojson: nextGeoJson,
    });
    updateShapeNameLabel(layer, layer.shapeName || "");
    refreshShapeMeasurementMarkers(layer);
    setDrawStatus(options.successMessage || "図形編集: 位置を保存しました。");
  } catch (_error) {
    restoreShapeGeometry(layer, snapshot);
    updateShapeNameLabel(layer, layer.shapeName || "");
    refreshShapeMeasurementMarkers(layer);
    setDrawStatus("図形編集: 保存に失敗したため元の形状へ戻しました。", true);
  } finally {
    isShapeGeometrySaving = false;
    if (
      geometryEditingShapeLayer === layer &&
      (currentMapMode === "edit" || currentMapMode === "input") &&
      !activeDrawMode
    ) {
      rebuildShapeGeometryHandles(layer);
    }
  }
}

// 頂点ハンドルの現在位置を図形の頂点へ同期する
function syncShapeGeometryHandlePositions(layer, activeHandle = null) {
  const vertices = flattenShapeLatLngs(layer?.getLatLngs?.());
  shapeGeometryEditHandles.eachLayer((handle) => {
    if (handle === activeHandle) {
      return;
    }
    const vertex = vertices[handle.shapeVertexIndex];
    if (vertex) {
      handle.setLatLng(vertex);
    }
  });
}

// 頂点ハンドルのドラッグ位置を対象図形へ反映する
function applyShapeVertexDrag(layer, vertexIndex, nextLatLng, activeHandle) {
  const vertices = flattenShapeLatLngs(layer?.getLatLngs?.()).map((latLng) =>
    cloneShapeLatLngs(latLng),
  );
  if (!vertices[vertexIndex]) {
    return;
  }

  if (layer.shapeType === "rectangle" && vertices.length === 4) {
    const oppositeVertex =
      activeHandle?.shapeRectangleOppositeLatLng ||
      vertices[(vertexIndex + 2) % 4];
    const nextBounds = L.latLngBounds(oppositeVertex, nextLatLng);
    layer.setLatLngs([
      nextBounds.getSouthWest(),
      nextBounds.getNorthWest(),
      nextBounds.getNorthEast(),
      nextBounds.getSouthEast(),
    ]);
    syncShapeGeometryHandlePositions(layer, activeHandle);
  } else {
    vertices[vertexIndex] = nextLatLng;
    layer.setLatLngs(vertices);
  }
  refreshShapeGeometryPresentation(layer);
}

// 入力モードで指定された頂点を削除し、既存の図形更新 API へ保存する
async function deleteShapeVertex(layer, vertexIndex) {
  if (
    currentMapMode !== "input" ||
    geometryEditingShapeLayer !== layer ||
    activeDrawMode ||
    isShapeGeometrySaving
  ) {
    return false;
  }

  const rawVertices = flattenShapeLatLngs(layer?.getLatLngs?.());
  const vertices = (
    layer.shapeType === "polygon" || layer.shapeType === "rectangle"
      ? trimClosedLatLngs(rawVertices)
      : rawVertices
  ).map((latLng) => cloneShapeLatLngs(latLng));
  const minimumVertexCount = layer.shapeType === "polyline" ? 2 : 3;
  if (vertices.length <= minimumVertexCount) {
    setDrawStatus(
      layer.shapeType === "polyline"
        ? "図形編集: 折れ線は2頂点未満にできません。"
        : "図形編集: ポリゴンは3頂点未満にできません。",
      true,
      true,
    );
    return false;
  }

  if (!vertices[vertexIndex]) {
    return false;
  }

  const snapshot = captureShapeGeometry(layer);
  const shouldConvertRectangle = layer.shapeType === "rectangle";
  vertices.splice(vertexIndex, 1);
  layer.setLatLngs(vertices);
  rebuildShapeGeometryHandles(layer);
  refreshShapeGeometryPresentation(layer);
  setDrawStatus("図形編集: 頂点を保存しています。");

  await persistShapeGeometryEdit(layer, snapshot, {
    shapeType: shouldConvertRectangle ? "polygon" : layer.shapeType,
    successMessage: shouldConvertRectangle
      ? "図形編集: 頂点を削除し、矩形をポリゴンへ変換しました。"
      : "図形編集: 頂点を削除しました。",
  });
  return true;
}

// 入力モードの頂点位置に削除確認ポップアップを開く
function openShapeVertexDeletePopup(layer, handle, event) {
  if (
    currentMapMode !== "input" ||
    geometryEditingShapeLayer !== layer ||
    activeDrawMode ||
    isShapeGeometrySaving
  ) {
    return;
  }

  if (event?.originalEvent) {
    L.DomEvent.stop(event.originalEvent);
  }
  closeShapeNameEditor();
  closeShapeVertexDeletePopup();

  const vertexIndex = handle.shapeVertexIndex;
  const content = document.createElement("div");
  content.className = "shape-vertex-delete-confirm";

  const message = document.createElement("div");
  message.className = "shape-vertex-delete-confirm-message";
  message.textContent = "頂点を削除しますか？";

  const actions = document.createElement("div");
  actions.className = "shape-vertex-delete-confirm-actions";

  const closeButton = document.createElement("button");
  closeButton.type = "button";
  closeButton.className = "shape-vertex-delete-confirm-button";
  closeButton.textContent = "閉じる";

  const deleteButton = document.createElement("button");
  deleteButton.type = "button";
  deleteButton.className =
    "shape-vertex-delete-confirm-button shape-vertex-delete-confirm-button--delete";
  deleteButton.textContent = "削除";

  actions.append(closeButton, deleteButton);
  content.append(message, actions);

  const popup = L.popup({
    className: "shape-vertex-delete-popup",
    closeButton: false,
    maxWidth: 220,
  })
    .setLatLng(handle.getLatLng())
    .setContent(content)
    .addTo(map);

  shapeVertexDeletePopup = popup;
  shapeVertexDeleteTarget = { layer, vertexIndex };
  popup.on("remove", () => {
    if (shapeVertexDeletePopup === popup) {
      shapeVertexDeletePopup = null;
      shapeVertexDeleteTarget = null;
    }
  });

  L.DomEvent.on(closeButton, "click", (buttonEvent) => {
    L.DomEvent.stop(buttonEvent);
    closeShapeVertexDeletePopup();
  });
  L.DomEvent.on(deleteButton, "click", (buttonEvent) => {
    suppressPropagatedMapClick({
      type: "click",
      originalEvent: buttonEvent,
    });
    L.DomEvent.stop(buttonEvent);
    if (
      shapeVertexDeleteTarget?.layer !== layer ||
      shapeVertexDeleteTarget?.vertexIndex !== vertexIndex
    ) {
      return;
    }
    closeShapeVertexDeletePopup();
    void deleteShapeVertex(layer, vertexIndex);
  });
}

// 選択図形の頂点へ表示用またはドラッグ可能なハンドルを配置する
function rebuildShapeGeometryHandles(layer) {
  closeShapeVertexDeletePopup();
  shapeGeometryEditHandles.clearLayers();
  const isVertexMoveMode = currentMapMode === "edit";
  const isVertexDisplayMode = currentMapMode === "input";
  if (
    !layer ||
    layer.shapeType === "circle" ||
    (!isVertexMoveMode && !isVertexDisplayMode) ||
    activeDrawMode ||
    !map.hasLayer(drawnShapesGroup)
  ) {
    return;
  }

  const rawVertices = flattenShapeLatLngs(layer.getLatLngs?.());
  const vertices =
    layer.shapeType === "polygon" || layer.shapeType === "rectangle"
      ? trimClosedLatLngs(rawVertices)
      : rawVertices;
  vertices.forEach((latLng, vertexIndex) => {
    const handle = L.marker(latLng, {
      draggable: isVertexMoveMode && !isShapeGeometrySaving,
      interactive: isVertexMoveMode || isVertexDisplayMode,
      keyboard: false,
      autoPan: isVertexMoveMode,
      icon: L.divIcon({
        className: isVertexMoveMode
          ? "shape-edit-vertex-icon"
          : "shape-edit-vertex-icon shape-vertex-display-icon",
        html: '<span class="shape-edit-vertex-handle" aria-hidden="true"></span>',
        iconSize: [24, 24],
        iconAnchor: [12, 12],
      }),
    });
    handle.shapeVertexIndex = vertexIndex;
    if (isVertexDisplayMode) {
      handle.on("click", (event) => {
        if (event?.originalEvent) {
          L.DomEvent.stop(event.originalEvent);
        }
      });
      handle.on("contextmenu", (event) => {
        openShapeVertexDeletePopup(layer, handle, event);
      });
    }
    if (isVertexMoveMode) {
      handle.on("dragstart", () => {
        handle.shapeGeometrySnapshot = captureShapeGeometry(layer);
        if (layer.shapeType === "rectangle" && vertices.length === 4) {
          handle.shapeRectangleOppositeLatLng = cloneShapeLatLngs(
            vertices[(vertexIndex + 2) % 4],
          );
        }
        closeShapeNameEditor();
      });
      handle.on("drag", () => {
        applyShapeVertexDrag(layer, vertexIndex, handle.getLatLng(), handle);
      });
      handle.on("dragend", async () => {
        await persistShapeGeometryEdit(layer, handle.shapeGeometrySnapshot);
        handle.shapeGeometrySnapshot = null;
        handle.shapeRectangleOppositeLatLng = null;
      });
    }
    shapeGeometryEditHandles.addLayer(handle);
  });

  if (!map.hasLayer(shapeGeometryEditHandles)) {
    shapeGeometryEditHandles.addTo(map);
  }
}

// 移動モードでクリックされた図形を編集対象として選択する
function selectShapeForGeometryEdit(layer) {
  if (
    currentMapMode !== "edit" ||
    activeDrawMode ||
    isShapeGeometrySaving ||
    !layer?.shapeId ||
    layer.isMeasurementLabel === true ||
    !map.hasLayer(drawnShapesGroup)
  ) {
    return false;
  }

  closeShapeNameEditor();
  if (geometryEditingShapeLayer !== layer) {
    setShapeGeometrySelectedStyle(geometryEditingShapeLayer, false);
    geometryEditingShapeLayer = layer;
  }
  setShapeGeometrySelectedStyle(layer, true);
  if (typeof layer.bringToFront === "function") {
    layer.bringToFront();
  }
  rebuildShapeGeometryHandles(layer);
  setDrawStatus(
    layer.shapeType === "circle"
      ? "図形編集: 円をドラッグして移動できます。"
      : "図形編集: 頂点をドラッグして移動できます。",
  );
  return true;
}

// 入力モードで頂点追加対象の図形を選択し、現在の頂点を表示する
function activateShapeForVertexAdd(layer) {
  if (
    currentMapMode !== "input" ||
    activeDrawMode ||
    !canAddVertexToShape(layer) ||
    !map.hasLayer(drawnShapesGroup)
  ) {
    return false;
  }

  closeShapeNameEditor();
  if (geometryEditingShapeLayer !== layer) {
    setShapeGeometrySelectedStyle(geometryEditingShapeLayer, false);
    geometryEditingShapeLayer = layer;
  }
  setShapeGeometrySelectedStyle(layer, true);
  if (typeof layer.bringToFront === "function") {
    layer.bringToFront();
  }
  rebuildShapeGeometryHandles(layer);
  return true;
}

// DOM のマウス・タッチイベントから地図上の緯度経度を取得する
function getShapeDragEventLatLng(event) {
  const sourceEvent =
    event?.touches?.[0] || event?.changedTouches?.[0] || event;
  if (
    !Number.isFinite(sourceEvent?.clientX) ||
    !Number.isFinite(sourceEvent?.clientY)
  ) {
    return null;
  }
  const mapRect = map.getContainer().getBoundingClientRect();
  return map.containerPointToLatLng(
    L.point(
      sourceEvent.clientX - mapRect.left,
      sourceEvent.clientY - mapRect.top,
    ),
  );
}

// 円本体のドラッグを開始する
function startCircleShapeDrag(layer, leafletEvent) {
  if (
    layer?.shapeType !== "circle" ||
    currentMapMode !== "edit" ||
    activeDrawMode ||
    isShapeGeometrySaving ||
    circleShapeDragState
  ) {
    return;
  }
  if (!selectShapeForGeometryEdit(layer)) {
    return;
  }

  const originalEvent = leafletEvent?.originalEvent;
  const startPointerLatLng = getShapeDragEventLatLng(originalEvent);
  if (!startPointerLatLng) {
    return;
  }
  if (originalEvent) {
    L.DomEvent.stop(originalEvent);
    originalEvent.preventDefault?.();
  }

  const zoom = map.getZoom();
  circleShapeDragState = {
    layer,
    snapshot: captureShapeGeometry(layer),
    zoom,
    startCenterPoint: map.project(layer.getLatLng(), zoom),
    startPointerPoint: map.project(startPointerLatLng, zoom),
    mapDraggingWasEnabled: Boolean(map.dragging?.enabled?.()),
  };
  if (circleShapeDragState.mapDraggingWasEnabled) {
    map.dragging.disable();
  }
  map.getContainer()?.classList.add("is-shape-geometry-dragging");
  document.addEventListener("mousemove", handleCircleShapeDragMove, true);
  document.addEventListener("mouseup", handleCircleShapeDragEnd, true);
  document.addEventListener("touchmove", handleCircleShapeDragMove, {
    capture: true,
    passive: false,
  });
  document.addEventListener("touchend", handleCircleShapeDragEnd, true);
  document.addEventListener("touchcancel", handleCircleShapeDragEnd, true);
}

// 円ドラッグ中のポインター移動量を中心座標へ反映する
function handleCircleShapeDragMove(event) {
  if (!circleShapeDragState) {
    return;
  }
  const pointerLatLng = getShapeDragEventLatLng(event);
  if (!pointerLatLng) {
    return;
  }
  event.preventDefault?.();
  const currentPointerPoint = map.project(
    pointerLatLng,
    circleShapeDragState.zoom,
  );
  const pointerOffset = currentPointerPoint.subtract(
    circleShapeDragState.startPointerPoint,
  );
  const nextCenter = map.unproject(
    circleShapeDragState.startCenterPoint.add(pointerOffset),
    circleShapeDragState.zoom,
  );
  circleShapeDragState.layer.setLatLng(nextCenter);
  refreshShapeGeometryPresentation(circleShapeDragState.layer);
}

// 円ドラッグ終了時に操作を解除して変更後の位置を保存する
async function handleCircleShapeDragEnd(event) {
  if (!circleShapeDragState) {
    return;
  }
  event?.preventDefault?.();
  const completedDrag = circleShapeDragState;
  releaseCircleShapeDragInteractions();
  circleShapeDragState = null;
  await persistShapeGeometryEdit(completedDrag.layer, completedDrag.snapshot);
}

// 入力モードで頂点追加できる図形種別か判定する
function canAddVertexToShape(layer) {
  return Boolean(
    layer?.shapeId &&
      layer.isMeasurementLabel !== true &&
      ["polygon", "polyline", "rectangle"].includes(layer.shapeType),
  );
}

// クリック位置から線分上の最近傍点を画面座標で求める
function getClosestPointOnShapeSegment(targetPoint, startPoint, endPoint) {
  const segmentX = endPoint.x - startPoint.x;
  const segmentY = endPoint.y - startPoint.y;
  const segmentLengthSquared = segmentX * segmentX + segmentY * segmentY;
  if (segmentLengthSquared === 0) {
    return startPoint;
  }

  const targetX = targetPoint.x - startPoint.x;
  const targetY = targetPoint.y - startPoint.y;
  const ratio = Math.max(
    0,
    Math.min(
      1,
      (targetX * segmentX + targetY * segmentY) / segmentLengthSquared,
    ),
  );
  return L.point(
    startPoint.x + segmentX * ratio,
    startPoint.y + segmentY * ratio,
  );
}

// 図形の全辺からクリック位置に最も近い辺と挿入座標を取得する
function findShapeVertexInsertion(layer, targetLatLng) {
  if (!canAddVertexToShape(layer) || !targetLatLng) {
    return null;
  }

  const vertices = flattenShapeLatLngs(layer.getLatLngs?.());
  if (vertices.length < 2) {
    return null;
  }

  const isClosedShape =
    layer.shapeType === "polygon" || layer.shapeType === "rectangle";
  const segmentCount = isClosedShape ? vertices.length : vertices.length - 1;
  const targetPoint = map.latLngToLayerPoint(targetLatLng);
  let closestMatch = null;

  for (let segmentIndex = 0; segmentIndex < segmentCount; segmentIndex += 1) {
    const nextVertexIndex = (segmentIndex + 1) % vertices.length;
    const startPoint = map.latLngToLayerPoint(vertices[segmentIndex]);
    const endPoint = map.latLngToLayerPoint(vertices[nextVertexIndex]);
    const closestPoint = getClosestPointOnShapeSegment(
      targetPoint,
      startPoint,
      endPoint,
    );
    const distancePx = targetPoint.distanceTo(closestPoint);
    if (!closestMatch || distancePx < closestMatch.distancePx) {
      closestMatch = {
        distancePx,
        insertionIndex: segmentIndex + 1,
        latLng: map.layerPointToLatLng(closestPoint),
      };
    }
  }

  if (
    !closestMatch ||
    closestMatch.distancePx > SHAPE_VERTEX_ADD_TOLERANCE_PX
  ) {
    return null;
  }

  const closestPoint = map.latLngToLayerPoint(closestMatch.latLng);
  closestMatch.existingVertexDistancePx = vertices.reduce(
    (minimumDistance, vertex) =>
      Math.min(
        minimumDistance,
        closestPoint.distanceTo(map.latLngToLayerPoint(vertex)),
      ),
    Number.POSITIVE_INFINITY,
  );
  return closestMatch;
}

// 頂点追加・図形選択に使用したイベントをマーカー追加へ伝播させない
function consumeShapeVertexAddEvent(event) {
  if (event?.originalEvent) {
    L.DomEvent.stop(event.originalEvent);
  }
  if (event?.type === "touchend") {
    suppressNextMapClick();
  } else {
    suppressMapClickUntil = 0;
  }
  closeShapeNameEditor();
}

// 入力モードの最初の操作では図形の選択と頂点表示だけを行う
function activateShapeForVertexAddFromEvent(
  layer,
  event,
  shouldSuppressPropagatedMapClick = false,
) {
  if (shouldSuppressPropagatedMapClick) {
    suppressPropagatedMapClick(event);
  }
  consumeShapeVertexAddEvent(event);
  if (isShapeGeometrySaving) {
    setDrawStatus(
      "図形編集: 保存中です。少し待ってから図形を選択してください。",
      true,
    );
    return true;
  }
  if (!activateShapeForVertexAdd(layer)) {
    return false;
  }
  setDrawStatus(
    "図形編集: 図形を選択しました。頂点を追加する辺をクリックしてください。",
  );
  return true;
}

// 入力モードで図形の辺をクリックした位置へ新しい頂点を追加する
function tryAddShapeVertex(layer, event, knownInsertion = null) {
  if (
    currentMapMode !== "input" ||
    activeDrawMode ||
    !canAddVertexToShape(layer)
  ) {
    return false;
  }

  const insertion =
    knownInsertion || findShapeVertexInsertion(layer, event?.latlng);
  if (!insertion) {
    return false;
  }

  consumeShapeVertexAddEvent(event);

  if (isShapeGeometrySaving) {
    setDrawStatus(
      "図形編集: 保存中です。少し待ってから追加してください。",
      true,
    );
    return true;
  }

  activateShapeForVertexAdd(layer);
  if (insertion.existingVertexDistancePx < SHAPE_VERTEX_MIN_DISTANCE_PX) {
    setDrawStatus("図形編集: 既存の頂点に近すぎるため追加できません。", true);
    return true;
  }

  const snapshot = captureShapeGeometry(layer);
  const vertices = flattenShapeLatLngs(layer.getLatLngs?.()).map((latLng) =>
    cloneShapeLatLngs(latLng),
  );
  vertices.splice(insertion.insertionIndex, 0, insertion.latLng);
  layer.setLatLngs(vertices);
  rebuildShapeGeometryHandles(layer);
  refreshShapeGeometryPresentation(layer);
  setDrawStatus("図形編集: 頂点を保存しています。");

  void persistShapeGeometryEdit(layer, snapshot, {
    shapeType: layer.shapeType === "rectangle" ? "polygon" : layer.shapeType,
    successMessage:
      layer.shapeType === "rectangle"
        ? "図形編集: 頂点を追加し、矩形をポリゴンへ変換しました。"
        : "図形編集: 頂点を追加しました。",
  });
  return true;
}

// 入力モードのクリック位置に最も近い図形の辺へ頂点を追加する
function tryAddShapeVertexAtLatLng(event) {
  if (
    currentMapMode !== "input" ||
    activeDrawMode ||
    !map.hasLayer(drawnShapesGroup)
  ) {
    return false;
  }

  let closestTarget = null;
  drawnShapesGroup.eachLayer((layer) => {
    const insertion = findShapeVertexInsertion(layer, event?.latlng);
    if (
      insertion &&
      (!closestTarget ||
        insertion.distancePx < closestTarget.insertion.distancePx)
    ) {
      closestTarget = { layer, insertion };
    }
  });

  if (!closestTarget) {
    return false;
  }
  if (geometryEditingShapeLayer !== closestTarget.layer) {
    return activateShapeForVertexAddFromEvent(closestTarget.layer, event);
  }
  return tryAddShapeVertex(closestTarget.layer, event, closestTarget.insertion);
}

// 入力モードで頂点追加できる図形へカーソル用クラスを反映する
function updateShapeVertexAddTargetStyles() {
  drawnShapesGroup.eachLayer((layer) => {
    const element = layer?.getElement?.();
    if (!element) {
      return;
    }
    element.classList.toggle(
      "is-shape-vertex-add-target",
      currentMapMode === "input" && canAddVertexToShape(layer),
    );
  });
}

// 閲覧・入力・移動モードに合わせて図形編集状態を切り替える
function setShapeGeometryEditingMode(mode) {
  currentMapMode = mode;
  map.getContainer()?.classList.toggle("is-shape-edit-mode", mode === "edit");
  clearShapeGeometryEditing();
  updateShapeVertexAddTargetStyles();
}

// 図形クリック時の削除や編集開始に必要なイベントを付与する
function attachShapeEvents(layer) {
  if (mapEditorProfile.bindPolylineHoverHighlight) {
    bindPolylineHoverHighlight(layer, {
      restoreStyle: () => applyShapeStyle(layer, activeDrawMode === "delete"),
    });
  }

  const handleDeleteEvent = async function (
    event,
    shouldSuppressClick = false,
  ) {
    if (activeDrawMode === "delete") {
      if (event.originalEvent) {
        L.DomEvent.stop(event.originalEvent);
      }
      if (shouldSuppressClick) {
        suppressNextMapClick();
      }

      try {
        const didDelete = await deleteShape(layer);
        if (didDelete) {
          resetDrawingState("図形描画: 削除しました。");
        }
      } catch (_error) {
        if (isShapeIdDeleted(layer)) {
          resetDrawingState("図形描画: 削除しました。");
          return;
        }
        setDrawStatus("図形描画: 削除に失敗しました。", true);
      }
      return;
    }

    if (activeDrawMode) {
      return;
    }

    if (currentMapMode === "input" && canAddVertexToShape(layer)) {
      if (geometryEditingShapeLayer !== layer) {
        activateShapeForVertexAddFromEvent(layer, event, true);
        return;
      }
      if (
        event.type === "click" &&
        !findShapeVertexInsertion(layer, event?.latlng)
      ) {
        consumeShapeVertexAddEvent(event);
        setDrawStatus(
          "図形編集: 頂点を追加する場合は選択中の図形の辺をクリックしてください。",
          true,
        );
        return;
      }
    }

    if (currentMapMode === "edit") {
      if (event.originalEvent) {
        L.DomEvent.stop(event.originalEvent);
      }
      if (shouldSuppressClick) {
        suppressNextMapClick();
      }
      selectShapeForGeometryEdit(layer);
      return;
    }

    if (currentMapMode === "view") {
      openShapeMemoPopup(layer, event?.latlng);
    }
  };

  layer.on("click", async function (event) {
    await handleDeleteEvent(event);
  });

  layer.on("touchend", async function (event) {
    await handleDeleteEvent(event, true);
  });
  layer.on("add", updateShapeVertexAddTargetStyles);

  if (layer.shapeType === "circle") {
    layer.on("mousedown", function (event) {
      startCircleShapeDrag(layer, event);
    });
    layer.on("touchstart", function (event) {
      startCircleShapeDrag(layer, event);
    });
  }
}

// 図形を現在レイヤへ保存し、保存後の情報をレイヤへ反映する
