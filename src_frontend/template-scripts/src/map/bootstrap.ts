import type { MapBootstrap } from "./types";

const MAP_PAGES = new Set<MapBootstrap["page"]>([
  "map",
  "map-mobile",
  "map-anather",
  "temporary-map",
  "temporary-map-mobile",
]);

declare global {
  interface Window {
    __GEOCODE_MAP_BOOTSTRAP__?: unknown;
  }
}

export function readMapBootstrap(): MapBootstrap {
  const value = window.__GEOCODE_MAP_BOOTSTRAP__;
  if (
    !isRecord(value) ||
    typeof value.page !== "string" ||
    !MAP_PAGES.has(value.page as MapBootstrap["page"]) ||
    !isRecord(value.tileServers) ||
    !isRecord(value.layers) ||
    !isRecord(value.markers)
  ) {
    throw new Error("Map bootstrap data is invalid");
  }

  if (value.page === "map-anather") {
    if (
      typeof value.isCluster !== "boolean" ||
      !Array.isArray(value.shapes) ||
      !isInitialView(value.initialView)
    ) {
      throw new Error("Another-map bootstrap data is invalid");
    }
  } else if (value.page === "map" || value.page === "map-mobile") {
    if (
      typeof value.selectedLayer !== "string" ||
      typeof value.isMaster !== "boolean" ||
      typeof value.markerId !== "string" ||
      !Array.isArray(value.shapes) ||
      !isInitialView(value.initialView)
    ) {
      throw new Error("Editable-map bootstrap data is invalid");
    }
  } else if (
    value.isMaster !== false ||
    typeof value.isChecked !== "boolean" ||
    typeof value.isMapUiHidden !== "boolean" ||
    !isRecord(value.shapes) ||
    !isInitialView(value.initialView)
  ) {
    throw new Error("Temporary-map bootstrap data is invalid");
  }

  return value as unknown as MapBootstrap;
}

function isInitialView(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.latitude === "number" &&
    typeof value.longitude === "number" &&
    typeof value.zoom === "number"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
