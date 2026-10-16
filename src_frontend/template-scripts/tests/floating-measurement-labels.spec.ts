import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bindFloatingMeasurementLabels,
  hasFloatingMeasurementLabels,
} from "../src/map/common/floating-measurement-labels";
import { filterMeasurementMarkersForBounds } from "../src/map/common/search";
import { createShapeMeasurementRuntime } from "../src/map/common/shape-measurement";
import { createShapeViewportRuntime } from "../src/map/common/shape-viewport";

const require = createRequire(import.meta.url);
const L = require("leaflet");
const maps: any[] = [];
afterEach(() => {
  maps.splice(0).forEach((map) => map.remove());
  document.body.replaceChildren();
});

function setup(scale = 1) {
  const container = document.createElement("div");
  document.body.append(container);
  Object.defineProperties(container, {
    offsetWidth: { value: 500 },
    clientWidth: { value: 500 },
    offsetHeight: { value: 400 },
    clientHeight: { value: 400 },
  });
  container.getBoundingClientRect = () =>
    ({ left: 100, top: 50, width: 500 * scale, height: 400 * scale }) as DOMRect;
  const map = L.map(container, { center: [35, 139], zoom: 10, maxZoom: 20, zoomAnimation: false });
  maps.push(map);
  const runtime = createShapeMeasurementRuntime({
    getMap: () => map,
    getLeaflet: () => L,
    escapeHtml: (s) => s,
    flattenShapeLatLngs: () => [],
    getDefaultShapeColor: () => "red",
    getSegmentLabelGroupSize: () => 2,
    normalizeShapeColor: () => "red",
  });
  const makeMarker = (variant = "segment", position = map.getCenter()) =>
    runtime.createMeasurementLabelMarker(position, ["10 m"], variant as any) as any;
  const panelFor = (marker: any) => {
    const panel = marker.getElement().querySelector(".shape-measure-label") as HTMLElement;
    panel.setPointerCapture = vi.fn();
    panel.hasPointerCapture = () => true;
    panel.releasePointerCapture = vi.fn();
    return panel;
  };
  const dispatch = (
    panel: HTMLElement,
    type: string,
    x: number,
    y: number,
    pointerType = "mouse",
  ) => {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.assign(event, {
      pointerId: 1,
      pointerType,
      button: 0,
      clientX: 100 + x * scale,
      clientY: 50 + y * scale,
    });
    panel.dispatchEvent(event);
  };
  const drag = (marker: any, dx = 40, dy = 30, pointer = "mouse") => {
    const panel = panelFor(marker);
    dispatch(panel, "pointerdown", 100, 100, pointer);
    dispatch(panel, "pointermove", 100 + dx, 100 + dy, pointer);
    dispatch(panel, "pointerup", 100 + dx, 100 + dy, pointer);
    return panel;
  };
  return { map, container, runtime, makeMarker, panelFor, dispatch, drag };
}

// Leaflet の座標変換とマーカーの生成・破棄を使い、画面中央以外を中心とするホイール拡縮も検証する。
describe("geographic draggable measurement labels", () => {
  it.each([1, 0.5, 0.25])(
    "follows pan/zoom before and after mouse/touch dragging at preview scale %s",
    (scale) => {
      const { map, container, makeMarker, drag } = setup(scale);
      const marker = makeMarker();
      bindFloatingMeasurementLabels({}, [marker], map, false);
      marker.addTo(map);
      const anchor = marker.getLatLng();
      const panel = marker.getElement().firstElementChild;
      expect(panel.parentElement).toBe(marker.getElement());
      expect(container.querySelector(":scope > .shape-measure-label")).toBeNull();
      const assertAnchor = (latLng: any) => {
        expect(marker.getLatLng()).toEqual(latLng);
        expect(L.DomUtil.getPosition(marker.getElement())).toEqual(map.latLngToLayerPoint(latLng));
      };
      map.setZoomAround(L.point(120, 80), 11, { animate: false });
      assertAnchor(anchor);
      map.panBy([50, 20], { animate: false });
      assertAnchor(anchor);
      for (const pointer of ["mouse", "touch"]) {
        const initial = map.latLngToContainerPoint(marker.getLatLng());
        drag(marker, 40, 30, pointer);
        const current = map.latLngToContainerPoint(marker.getLatLng());
        expect(current.x - initial.x).toBeCloseTo(40);
        expect(current.y - initial.y).toBeCloseTo(30);
        const moved = marker.getLatLng();
        const beforeZoom = map.latLngToContainerPoint(moved);
        map.setZoomAround(L.point(100, 70), map.getZoom() + 1, { animate: false });
        expect(map.latLngToContainerPoint(moved)).not.toEqual(beforeZoom);
        assertAnchor(moved);
        map.panBy([20, 10], { animate: false });
        assertAnchor(moved);
      }
    },
  );

  it("restores dragged geographic coordinates before filtering, even when the shape is off screen", () => {
    const { map, makeMarker, drag } = setup();
    const layer = { getBounds: () => L.latLngBounds([0, 0], [1, 1]) };
    const marker = makeMarker("summary", L.latLng(0, 0));
    bindFloatingMeasurementLabels(layer, [marker], map, false);
    marker.addTo(map);
    const origin = map.latLngToContainerPoint(marker.getLatLng());
    drag(marker, 250 - origin.x, 200 - origin.y);
    const saved = marker.getLatLng();
    marker.remove();
    map.setZoomAround(L.point(110, 80), 11, { animate: false });
    const replacement = makeMarker("summary", L.latLng(0, 0));
    bindFloatingMeasurementLabels(layer, [replacement], map, false);
    expect(replacement.getLatLng()).toEqual(saved);
    expect(filterMeasurementMarkersForBounds([replacement], map.getBounds())).toEqual([
      replacement,
    ]);
    replacement.addTo(map);
    const attach = vi.fn();
    const manager = createShapeViewportRuntime({
      getShapeRecords: () => [],
      scheduleFrame: () => 1,
      cancelFrame: () => {},
    }).createViewportShapeMeasurementManager({
      map,
      getLayers: [layer],
      enabled: true,
      isLayerVisible: () => true,
      attachMarkers: attach,
      removeMarkers: () => {},
    });
    manager.refresh();
    expect(attach).toHaveBeenCalledWith(layer, expect.anything());
    map.panTo([0, 0], { animate: false });
    expect(filterMeasurementMarkersForBounds([replacement], map.getBounds())).toEqual([]);
    manager.destroy();
  });

  it("keeps unmoved anchors, moved shapes, segment modes and summary positions independent", () => {
    const { map, makeMarker, drag } = setup();
    const layer = {};
    const segment = makeMarker(),
      summary = makeMarker("summary");
    bindFloatingMeasurementLabels(layer, [segment, summary], map, false);
    segment.addTo(map);
    summary.addTo(map);
    expect(hasFloatingMeasurementLabels(layer)).toBe(false);
    drag(segment, 20, 0);
    drag(summary, 0, 30);
    const segmentPosition = segment.getLatLng(),
      summaryPosition = summary.getLatLng();
    segment.remove();
    summary.remove();
    const restored = makeMarker(),
      restoredSummary = makeMarker("summary");
    bindFloatingMeasurementLabels(layer, [restored, restoredSummary], map, false);
    expect(restored.getLatLng()).toEqual(segmentPosition);
    expect(restoredSummary.getLatLng()).toEqual(summaryPosition);
    const merged = makeMarker(),
      mergedSummary = makeMarker("summary");
    bindFloatingMeasurementLabels(layer, [merged, mergedSummary], map, true);
    expect(merged.getLatLng()).toEqual(map.getCenter());
    expect(mergedSummary.getLatLng()).toEqual(summaryPosition);
    const other = makeMarker();
    bindFloatingMeasurementLabels({}, [other], map, false);
    expect(other.getLatLng()).toEqual(map.getCenter());
    expect(hasFloatingMeasurementLabels({})).toBe(false);
  });

  it("keeps default and moved labels present during zoom animation and removes them when disabled", () => {
    const { map, makeMarker } = setup();
    const layer = { getBounds: () => map.getBounds() },
      marker = makeMarker();
    bindFloatingMeasurementLabels(layer, [marker], map, false);
    marker.addTo(map);
    const remove = vi.fn(() => marker.remove());
    const attach = vi.fn(() => marker.addTo(map));
    const manager = createShapeViewportRuntime({
      getShapeRecords: () => [],
      scheduleFrame: () => 1,
      cancelFrame: () => {},
    }).createViewportShapeMeasurementManager({
      map,
      getLayers: [layer],
      enabled: true,
      isLayerVisible: () => true,
      attachMarkers: attach,
      removeMarkers: remove,
    });
    map.fire("zoomstart");
    expect(remove).not.toHaveBeenCalled();
    expect(map.hasLayer(marker)).toBe(true);
    manager.refresh();
    expect(attach).not.toHaveBeenCalled();
    map.fire("zoomend");
    manager.refresh();
    expect(attach).toHaveBeenCalledOnce();
    manager.setEnabled(false);
    expect(map.hasLayer(marker)).toBe(false);
    manager.destroy();
  });

  it("blocks map operations while dragging, respects visibility and cleans up cancelled drags", () => {
    const { map, container, runtime, makeMarker, panelFor, dispatch } = setup();
    const marker = makeMarker();
    bindFloatingMeasurementLabels({}, [marker], map, false);
    marker.addTo(map);
    const panel = panelFor(marker),
      original = marker.getLatLng();
    const mapPointer = vi.fn(),
      mapClick = vi.fn();
    container.addEventListener("pointerdown", mapPointer);
    container.addEventListener("click", mapClick);
    dispatch(panel, "pointerdown", 100, 100);
    panel.click();
    expect(mapPointer).not.toHaveBeenCalled();
    expect(mapClick).not.toHaveBeenCalled();
    dispatch(panel, "pointercancel", 100, 100);
    dispatch(panel, "pointermove", 150, 150);
    expect(marker.getLatLng()).toEqual(original);
    runtime.setMeasurementMarkerVisibility(marker, false);
    expect(marker.getElement().style.display).toBe("none");
    runtime.setMeasurementMarkerVisibility(marker, true);
    expect(marker.getElement().style.display).toBe("");
    dispatch(panel, "pointerdown", 100, 100);
    marker.remove();
    expect(panel.releasePointerCapture).toHaveBeenCalledWith(1);
    dispatch(panel, "pointermove", 150, 150);
    expect(marker.getLatLng()).toEqual(original);
    expect(panel.style.cursor).toBe("");
  });
});
