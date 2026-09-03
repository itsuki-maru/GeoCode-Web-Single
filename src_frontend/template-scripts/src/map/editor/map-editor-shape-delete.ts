// @ts-nocheck -- Leaflet編集画面の共有スコープを保ったまま移行する統合境界。
function bindVisibleShapeLabelEvents() {
  shapeNameLabelManager?.scheduleRefresh();
}

// 指定図形を削除し、Undo 用スタックへ退避する
async function deleteShape(layer) {
  if (!layer?.shapeId) {
    setDrawStatus("図形描画: 削除対象のIDがありません。", true);
    return false;
  }
  const shapeId = String(layer.shapeId);
  if (deletingShapeIds.has(shapeId) || deletedShapeIds.has(shapeId)) {
    return false;
  }
  deletingShapeIds.add(shapeId);
  if (layer.isDeletingShape || layer.isDeletedShape) {
    deletingShapeIds.delete(shapeId);
    return false;
  }
  layer.isDeletingShape = true;

  const deletedShape = {
    layerId: layer.layerId || layer.options?.shapeRecord?.layer_id || null,
    shapeType: layer.shapeType,
    name: layer.shapeName || "",
    geojson:
      layer.options?.shapeRecord?.geojson ||
      buildShapeGeoJson(
        layer,
        layer.shapeType,
        layer.shapeStyle || getDefaultShapeStyle(layer.shapeType),
      ),
  };

  let response;
  try {
    response = await fetchWithAuth(`/shape/${layer.shapeId}`, {
      method: "DELETE",
    });
  } catch (error) {
    layer.isDeletingShape = false;
    deletingShapeIds.delete(shapeId);
    throw error;
  }

  if (!response.ok) {
    layer.isDeletingShape = false;
    deletingShapeIds.delete(shapeId);
    throw new Error("shape delete failed");
  }

  layer.isDeletedShape = true;
  deletedShapeIds.add(shapeId);
  try {
    if (typeof clearFocusedShapeFocus === "function") {
      clearFocusedShapeFocus(layer);
    }
    removeShapeMeasurementMarkers(layer);
    drawnShapesGroup.removeLayer(layer);
    searchableShapeLayers.delete(layer);
    shapeNameLabelManager?.invalidate(layer);
    refreshAllShapeMeasurementMarkers();
    applyMeasurementVisibilityToDrawnShapesGroup();
    deletedShapesStack.push(deletedShape);
    updateUndoButtonState();
  } catch (error) {
    console.error("Shape deleted on server, but local cleanup failed:", error);
  } finally {
    layer.isDeletingShape = false;
    deletingShapeIds.delete(shapeId);
  }
  callParentReload();
  setDrawStatus("図形描画: 削除しました。");
  return true;
}

function getPointToSegmentDistance(point, segmentStart, segmentEnd) {
  const dx = segmentEnd.x - segmentStart.x;
  const dy = segmentEnd.y - segmentStart.y;
  if (dx === 0 && dy === 0) {
    return point.distanceTo(segmentStart);
  }

  const ratio = Math.max(
    0,
    Math.min(
      1,
      ((point.x - segmentStart.x) * dx + (point.y - segmentStart.y) * dy) /
        (dx * dx + dy * dy),
    ),
  );

  return point.distanceTo(
    L.point(segmentStart.x + ratio * dx, segmentStart.y + ratio * dy),
  );
}

function isPointInProjectedPolygon(point, polygonPoints) {
  let isInside = false;
  for (
    let i = 0, j = polygonPoints.length - 1;
    i < polygonPoints.length;
    j = i++
  ) {
    const current = polygonPoints[i];
    const previous = polygonPoints[j];
    const intersects =
      current.y > point.y !== previous.y > point.y &&
      point.x <
        ((previous.x - current.x) * (point.y - current.y)) /
          (previous.y - current.y) +
          current.x;
    if (intersects) {
      isInside = !isInside;
    }
  }
  return isInside;
}

function getProjectedSegmentDistance(point, latLngs, isClosed = false) {
  const projectedPoints = latLngs.map((latlng) =>
    map.latLngToLayerPoint(latlng),
  );
  if (projectedPoints.length === 0) {
    return Infinity;
  }
  if (projectedPoints.length === 1) {
    return point.distanceTo(projectedPoints[0]);
  }

  let minDistance = Infinity;
  for (let i = 1; i < projectedPoints.length; i += 1) {
    minDistance = Math.min(
      minDistance,
      getPointToSegmentDistance(
        point,
        projectedPoints[i - 1],
        projectedPoints[i],
      ),
    );
  }
  if (isClosed) {
    minDistance = Math.min(
      minDistance,
      getPointToSegmentDistance(
        point,
        projectedPoints[projectedPoints.length - 1],
        projectedPoints[0],
      ),
    );
  }
  return minDistance;
}

function getDeleteHitDistance(layer, latlng) {
  if (!layer || !latlng) {
    return Infinity;
  }

  const point = map.latLngToLayerPoint(latlng);
  if (layer.shapeType === "circle" && typeof layer.getLatLng === "function") {
    const centerPoint = map.latLngToLayerPoint(layer.getLatLng());
    const radius = Number(layer._radius);
    return Number.isFinite(radius) &&
      point.distanceTo(centerPoint) <= radius + DELETE_HIT_TOLERANCE_PX
      ? 0
      : Infinity;
  }

  const latLngs = flattenShapeLatLngs(layer.getLatLngs?.());
  if (latLngs.length === 0) {
    return Infinity;
  }

  if (layer.shapeType === "polygon" || layer.shapeType === "rectangle") {
    const polygonLatLngs = trimClosedLatLngs(latLngs);
    const polygonPoints = polygonLatLngs.map((polygonLatLng) =>
      map.latLngToLayerPoint(polygonLatLng),
    );
    if (
      polygonPoints.length >= 3 &&
      isPointInProjectedPolygon(point, polygonPoints)
    ) {
      return 0;
    }
    return getProjectedSegmentDistance(point, polygonLatLngs, true);
  }

  return getProjectedSegmentDistance(point, latLngs, false);
}

function findDeleteHitShape(latlng) {
  let hitLayer = null;
  let hitDistance = DELETE_HIT_TOLERANCE_PX;

  drawnShapesGroup.eachLayer((layer) => {
    const distance = getDeleteHitDistance(layer, latlng);
    if (distance <= hitDistance) {
      hitLayer = layer;
      hitDistance = distance;
    }
  });

  return hitLayer;
}

function isShapeIdDeleted(layer) {
  return Boolean(layer?.shapeId && deletedShapeIds.has(String(layer.shapeId)));
}

async function deleteShapeAtLatLng(latlng) {
  const hitLayer = findDeleteHitShape(latlng);
  if (!hitLayer) {
    setDrawStatus("図形描画: 削除対象の図形をクリックしてください。", true);
    return;
  }

  try {
    const didDelete = await deleteShape(hitLayer);
    if (didDelete) {
      resetDrawingState("図形描画: 削除しました。");
    }
  } catch (_error) {
    if (isShapeIdDeleted(hitLayer)) {
      resetDrawingState("図形描画: 削除しました。");
      return;
    }
    setDrawStatus("図形描画: 削除に失敗しました。", true);
  }
}

// 図形座標の編集中に復元できるよう、Leaflet の座標配列を複製する
