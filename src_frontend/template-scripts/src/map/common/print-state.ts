import type { StoredMapView } from "./map-view-persistence";

export interface PrintMapState {
  view: StoredMapView;
  tileServerId: string;
  overlays: Record<string, boolean>;
  markersVisible: boolean;
  shapesVisible: boolean;
  shapeNamesVisible: boolean;
  layerIds: string[] | null;
}

export function isPrintMapState(value: unknown): value is PrintMapState {
  if (!value || typeof value !== "object") return false;
  const state = value as PrintMapState;
  const view = state.view;
  return Boolean(
    view &&
      Number.isFinite(view.latitude) &&
      Math.abs(view.latitude) <= 90 &&
      Number.isFinite(view.longitude) &&
      Math.abs(view.longitude) <= 180 &&
      Number.isFinite(view.zoom) &&
      view.zoom >= 0 &&
      view.zoom <= 30 &&
      typeof state.tileServerId === "string" &&
      state.overlays &&
      typeof state.overlays === "object" &&
      !Array.isArray(state.overlays) &&
      Object.values(state.overlays).every((visible) => typeof visible === "boolean") &&
      typeof state.markersVisible === "boolean" &&
      typeof state.shapesVisible === "boolean" &&
      typeof state.shapeNamesVisible === "boolean" &&
      (state.layerIds === null ||
        (Array.isArray(state.layerIds) && state.layerIds.every((id) => typeof id === "string"))),
  );
}

export const PRINT_PAPERS = {
  "a4-portrait": { label: "A4 縦", width: 210, height: 297, page: "A4 portrait" },
  "a4-landscape": { label: "A4 横", width: 297, height: 210, page: "A4 landscape" },
  "a3-portrait": { label: "A3 縦", width: 297, height: 420, page: "A3 portrait" },
  "a3-landscape": { label: "A3 横", width: 420, height: 297, page: "A3 landscape" },
} as const;

export type PrintPaper = keyof typeof PRINT_PAPERS;
