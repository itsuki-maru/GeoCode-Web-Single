import type { MapBootstrap } from "./types";
import { restoreNormalBodyReferences } from "./normal-body-references";

const MAP_PAGES = new Set<MapBootstrap["page"]>([
  "map",
  "map-mobile",
  "map-anather",
  "form-answer-map",
  "temporary-map",
  "temporary-map-mobile",
]);

declare global {
  interface Window {
    __GEOCODE_MAP_BOOTSTRAP__?: unknown;
  }
}

export function readMapBootstrap(): MapBootstrap {
  let value = window.__GEOCODE_MAP_BOOTSTRAP__;
  let jsonNode: HTMLScriptElement | undefined;
  if (value === undefined) {
    const node = document.getElementById("geocode-map-bootstrap");
    if (!(node instanceof HTMLScriptElement) || node.type !== "application/json") {
      throw new Error("Map bootstrap data is invalid");
    }
    try {
      value = JSON.parse(node.textContent ?? "");
    } catch {
      throw new Error("Map bootstrap data is invalid");
    }
    if (!isRecord(value) || value.page !== "form-answer-map") {
      throw new Error("Answer-map bootstrap data is invalid");
    }
    restoreNormalBodyReferences(value);
    jsonNode = node;
  } else if (isRecord(value) && Object.hasOwn(value, "normalBodyReferences")) {
    throw new Error("Answer-map body references are invalid");
  }
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

  if (value.page === "map-anather" || value.page === "form-answer-map") {
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

  if (
    value.page === "form-answer-map" &&
    (!isRecord(value.answerPreview) ||
      !isRecord(value.answerPreview.query) ||
      !Array.isArray(value.answerPreview.targets))
  ) {
    throw new Error("Answer-map bootstrap data is invalid");
  }
  if (jsonNode) {
    // Later readers, including print preparation, reuse the validated snapshot.
    window.__GEOCODE_MAP_BOOTSTRAP__ = value;
    jsonNode.remove();
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
