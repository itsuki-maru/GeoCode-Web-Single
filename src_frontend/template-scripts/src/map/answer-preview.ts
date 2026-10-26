import type { AnotherMapBootstrap, FormAnswerMapBootstrap } from "./types";
import { installAnswerAnalysis } from "./answer-analysis";
import { answerShapeIds, extendAnswerShapeBounds } from "./answer-shapes";

export function hasValidAnswerGeometry(geojson: any): boolean {
  const geometry = geojson?.type === "Feature" ? geojson.geometry : geojson;
  const valid = (coordinates: unknown): boolean => {
    if (!Array.isArray(coordinates) || !coordinates.length) return false;
    if (typeof coordinates[0] === "number")
      return (
        coordinates.length >= 2 &&
        Number.isFinite(coordinates[0]) &&
        Number.isFinite(coordinates[1]) &&
        Math.abs(coordinates[0]) <= 180 &&
        Math.abs(coordinates[1]) <= 90
      );
    return coordinates.every(valid);
  };
  return valid(geometry?.coordinates);
}

interface PreviewLayer {
  getBounds?(): { isValid(): boolean };
  getLatLng?(): { lat: number; lng: number };
}

// 未生成の図形も原本の範囲から数える。円は中心だけでなく半径も含む。
export function finishAnswerPreview(
  runtime: any,
  bootstrap: AnotherMapBootstrap | FormAnswerMapBootstrap,
  leaflet: any,
) {
  const preview = bootstrap.answerPreview;
  if (!preview) return;
  const analysis =
    preview.analysis &&
    installAnswerAnalysis(runtime, preview.analysis, leaflet, (visible) => {
      window.parent.postMessage(
        { type: "answer-map-visible", requestId: preview.requestId, visible },
        preview.parentOrigin,
      );
    });
  const bounds = leaflet.latLngBounds([]);
  let displayed = 0;
  for (const layer of Object.values(runtime.markers) as PreviewLayer[]) {
    const extent = layer.getBounds?.();
    const point = layer.getLatLng?.();
    if (extent?.isValid()) {
      bounds.extend(extent);
      displayed++;
    } else if (
      point &&
      Number.isFinite(point.lat) &&
      Number.isFinite(point.lng) &&
      Math.abs(point.lat) <= 90 &&
      Math.abs(point.lng) <= 180
    ) {
      bounds.extend(point);
      displayed++;
    }
  }
  for (const id of answerShapeIds(runtime)) {
    if (extendAnswerShapeBounds(bounds, runtime, id)) displayed++;
  }
  runtime.map.invalidateSize();
  if (!runtime.hasInheritedMapView && bounds.isValid()) {
    runtime.map.fitBounds(bounds, { padding: [32, 32], maxZoom: 16 });
  }
  window.parent.postMessage(
    {
      type: "answer-map-ready",
      requestId: preview.requestId,
      answerCount: preview.answerCount,
      targetCount: preview.targetCount,
      displayed,
      skipped: Math.max(0, preview.targetCount - displayed),
      analysis: preview.analysis,
      visible: analysis ? analysis.visibleCounts() : [],
      query: preview.query,
      targets: preview.targets,
    },
    preview.parentOrigin,
  );
}
