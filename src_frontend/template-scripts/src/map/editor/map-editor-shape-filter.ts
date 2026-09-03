// @ts-nocheck -- PC編集画面固有の外部フィルター境界。
let externalShapeFilterIdSet = null;

function isShapeVisibleForExternalFilter(layer) {
  return Boolean(
    layer &&
      !layer.isDeletedShape &&
      (!externalShapeFilterIdSet ||
        externalShapeFilterIdSet.has(String(layer.shapeId))),
  );
}

function applyMapObjectFilter(markerIds, shapeIds) {
  applyMarkerFilter(markerIds);
  externalShapeFilterIdSet = Array.isArray(shapeIds)
    ? new Set(shapeIds.map(String))
    : null;
  renderVisibleShapes();
}
