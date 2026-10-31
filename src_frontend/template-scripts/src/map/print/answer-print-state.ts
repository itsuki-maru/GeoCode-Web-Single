import type { FormAnswerMapBootstrap } from "../types";
import { isPrintMapState, type PrintMapState } from "../common/print-state";
import { isPopupBody } from "../common/popup-content";
import { isAnswerColoring, type AnswerColoring } from "../answer-coloring";

export interface AnswerPrintSnapshot {
  state: PrintMapState;
  bootstrap: FormAnswerMapBootstrap;
  coloring?: AnswerColoring;
}
export const MAX_ANSWER_PRINT_BYTES = 32 * 1024 * 1024;
const record = (v: any): v is Record<string, any> =>
  !!v && typeof v === "object" && !Array.isArray(v);

/** 受信側のフレームは、追加のオブジェクトを取得できない設計とする。 */
export function isAnswerPrintSnapshot(v: any): v is AnswerPrintSnapshot {
  if (!record(v) || !isPrintMapState(v.state) || !record(v.bootstrap)) return false;
  const b = v.bootstrap;
  if (
    Object.hasOwn(b, "normalBodyReferences") ||
    b.page !== "form-answer-map" ||
    typeof b.isCluster !== "boolean" ||
    !record(b.layers) ||
    !record(b.markers) ||
    !Array.isArray(b.shapes) ||
    !record(b.tileServers) ||
    !Array.isArray(b.tileOverlays) ||
    !record(b.answerPreview) ||
    !record(b.answerPreview.query) ||
    !Array.isArray(b.answerPreview.targets)
  )
    return false;
  const markers = Object.values(b.markers),
    shapes = b.shapes;
  if (markers.length + shapes.length === 0) return false;
  if (
    !markers.every(
      (m) =>
        record(m) &&
        typeof m.id === "string" &&
        typeof m.layer_id === "string" &&
        record(b.layers[m.layer_id]) &&
        Number.isFinite(m.latitude) &&
        Math.abs(m.latitude) <= 90 &&
        Number.isFinite(m.longitude) &&
        Math.abs(m.longitude) <= 180 &&
        typeof m.detail === "string" &&
        typeof m.marker_name === "string",
    ) ||
    !shapes.every(
      (s) =>
        record(s) &&
        typeof s.id === "string" &&
        typeof s.layer_id === "string" &&
        record(b.layers[s.layer_id]) &&
        record(s.geojson) &&
        typeof s.shape_type === "string",
    )
  )
    return false;
  const keys = [...markers.map((m) => `marker:${m.id}`), ...shapes.map((s) => `shape:${s.id}`)];
  const keySet = new Set(keys);
  if (v.coloring !== undefined && !isAnswerColoring(v.coloring, keySet)) return false;
  if (
    b.popupBodies !== undefined &&
    (!record(b.popupBodies) ||
      Object.entries(b.popupBodies).some(([key, value]) => !keySet.has(key) || !isPopupBody(value)))
  )
    return false;
  if (
    b.popupAnalysis !== undefined &&
    (!record(b.popupAnalysis) ||
      Object.entries(b.popupAnalysis).some(
        ([key, value]) => !keySet.has(key) || typeof value !== "string",
      ))
  )
    return false;
  const targets = new Set(b.answerPreview.targets);
  if (
    keySet.size !== keys.length ||
    targets.size !== keys.length ||
    b.answerPreview.targets.length !== keys.length ||
    !keys.every((k) => targets.has(k))
  )
    return false;
  try {
    return new TextEncoder().encode(JSON.stringify(v)).length <= MAX_ANSWER_PRINT_BYTES;
  } catch {
    return false;
  }
}

export function createAnswerPrintSnapshot(
  bootstrap: FormAnswerMapBootstrap,
  runtime: any,
  keys: string[],
): AnswerPrintSnapshot {
  if (Object.hasOwn(bootstrap, "normalBodyReferences"))
    throw new Error("印刷対象が不正です。地図を開き直してください。");
  const targets = new Set(keys);
  const markers = Object.fromEntries(
    Object.entries(bootstrap.markers).filter(([, m]) => targets.has(`marker:${m.id}`)),
  );
  const shapes = bootstrap.shapes.filter((s) => targets.has(`shape:${s.id}`));
  const layerIds = new Set([
    ...Object.values(markers).map((m) => m.layer_id),
    ...shapes.map((s) => s.layer_id),
  ]);
  const state: PrintMapState = runtime.getPrintState();
  const coloring: AnswerColoring | null | undefined = runtime.answerColoring?.getState();
  const snapshot: AnswerPrintSnapshot = {
    state,
    bootstrap: {
      page: "form-answer-map",
      isCluster: bootstrap.isCluster,
      initialView: state.view,
      markers,
      shapes,
      popupBodies: Object.fromEntries(
        Object.entries(bootstrap.popupBodies || {}).filter(([key]) => targets.has(key)),
      ),
      popupAnalysis: Object.fromEntries(
        Object.entries(
          runtime.popupContent?.getAnalysis() || ({} as Record<string, string>),
        ).filter(([key]) => targets.has(key)),
      ) as Record<string, string>,
      layers: Object.fromEntries(
        Object.entries(bootstrap.layers).filter(([id]) => layerIds.has(id)),
      ),
      tileServers: bootstrap.tileServers,
      tileOverlays: bootstrap.tileOverlays || [],
      answerPreview: {
        ...bootstrap.answerPreview,
        analysis: undefined,
        targets: keys,
        targetCount: keys.length,
      },
    },
  };
  if (coloring) {
    snapshot.coloring = {
      ...coloring,
      targets: Object.fromEntries(
        Object.entries(coloring.targets).filter(([key]) => targets.has(key)),
      ),
    };
  }
  if (!isAnswerPrintSnapshot(snapshot))
    throw new Error(
      "印刷対象が不正、0件、またはデータ量が32MiBを超えています。条件を絞ってください。",
    );
  return JSON.parse(JSON.stringify(snapshot));
}
