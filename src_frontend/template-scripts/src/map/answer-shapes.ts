// Logical answer targets must not depend on whether a viewport layer exists.
// The layer fallback keeps the legacy analysis/runtime callers compatible.
export function hasRenderableAnswerShape(runtime: any, id: string): boolean {
  return runtime.shapeRenderer
    ? runtime.shapeRenderer.isRenderable(id)
    : Boolean(runtime.shapeLayers[`shape-${id}`]);
}

export function isAnswerShapeVisible(runtime: any, id: string): boolean {
  if (runtime.isShapeLogicallyVisible) return runtime.isShapeLogicallyVisible(id);
  const layer = runtime.shapeLayers[`shape-${id}`];
  return Boolean(layer && runtime.map.hasLayer(layer));
}

export function answerShapeIds(runtime: any): string[] {
  if (runtime.getRenderableShapeIds) return runtime.getRenderableShapeIds();
  return Object.keys(runtime.shapeLayers).map((key) => key.replace(/^shape-/, ""));
}

export function extendAnswerShapeBounds(bounds: any, runtime: any, id: string): boolean {
  const info = runtime.getShapeGeometryInfo?.(id);
  if (info) {
    const { south, west, north, east } = info.bounds;
    bounds.extend([south, west]);
    bounds.extend([north, east]);
    return true;
  }
  const layer = runtime.shapeLayers[`shape-${id}`];
  const extent = layer?.getBounds?.();
  if (extent?.isValid()) {
    bounds.extend(extent);
    return true;
  }
  const point = layer?.getLatLng?.();
  if (point) {
    bounds.extend(point);
    return true;
  }
  return false;
}
