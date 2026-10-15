import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createContext, runInContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { createShapeMeasurementRuntime } from "../src/map/common/shape-measurement";
import { createShapeViewportRuntime } from "../src/map/common/shape-viewport";

function setup() {
  const context = createContext({
    document,
    editorEntryProfile: { isMobile: false },
    currentMapMode: "view",
    activeDrawMode: null,
    measurementSelectedShapes: new Set(),
    measurementSelectionTouchTimes: new WeakMap(),
    measurementSelectionType: null,
    measurementSummaryElement: document.createElement("div"),
    isMeasurementVisible: true,
    isMeasurementSelectionActive: true,
    searchableShapeLayers: new Set(),
    mapEditorProfile: { isShapeVisibleForMeasurement: (layer: any) => !layer.hidden },
    map: {
      closePopup: vi.fn(),
      distance: (a: any, b: any) => Math.hypot(a.lat - b.lat, a.lng - b.lng),
      options: { crs: { project: (p: any) => ({ x: p.lng, y: p.lat }) } },
    },
    L: { DomEvent: { stop: vi.fn() } },
    closeShapeNameEditor: vi.fn(),
    applyShapeStyle: vi.fn(),
    setDrawStatus: vi.fn(),
    updateMeasurementControlState: vi.fn(),
    shapeMeasurementManager: { scheduleRefresh: vi.fn(), setEnabled: vi.fn() },
  });
  runInContext(
    readFileSync(resolve("src/map/editor/map-editor-shape-measurement.ts"), "utf8"),
    context,
  );
  Object.assign(
    context,
    createShapeMeasurementRuntime({
      escapeHtml: (v) => v,
      flattenShapeLatLngs: context.flattenShapeLatLngs,
      getDefaultShapeColor: () => "#d94841",
      getLeaflet: () => context.L,
      getMap: () => context.map,
      getSegmentLabelGroupSize: () => 2,
      normalizeShapeColor: () => "#d94841",
    }),
  );
  const select = (layer: any) => {
    context.searchableShapeLayers.add(layer);
    return context.handleMeasurementSelectionClick(layer, { originalEvent: { ctrlKey: false } });
  };
  const show = () => {
    context.isMeasurementVisible = true;
    context.updateMeasurementSummary();
    return context.measurementSummaryElement.textContent;
  };
  return { context, select, show };
}

const line = () => ({
  shapeType: "polyline",
  getLatLngs: () => [
    { lat: 0, lng: 0 },
    { lat: 3, lng: 4 },
  ],
});
const polygon = (shapeType = "polygon") => ({
  shapeType,
  getLatLngs: () => [
    [
      { lat: 0, lng: 0 },
      { lat: 0, lng: 4 },
      { lat: 3, lng: 4 },
      { lat: 3, lng: 0 },
    ],
  ],
});

describe("editor measurement selection", () => {
  it("exposes selection only while measurement is open and resets it on closing", () => {
    const { context: c, select } = setup();
    const controls = readFileSync(resolve("src/map/editor/map-editor-controls.ts"), "utf8");
    const start = controls.indexOf("function toggleMeasurementLabels()");
    runInContext(controls.slice(start, controls.indexOf("\n}", start) + 2), c);
    const button = document.createElement("button");
    button.id = "measurement-selection-toggle-btn";
    document.body.append(button);
    try {
      select(line());
      c.toggleMeasurementLabels();
      expect(c.isMeasurementVisible).toBe(false);
      expect(c.isMeasurementSelectionActive).toBe(false);
      expect(c.measurementSelectedShapes.size).toBe(0);
      expect(button.classList.contains("is-hidden")).toBe(true);
      c.toggleMeasurementLabels();
      expect(button.classList.contains("is-hidden")).toBe(false);
      expect(c.isMeasurementSelectionActive).toBe(false);
      c.currentMapMode = "edit";
      c.updateMeasurementSelectionControl();
      expect(button.disabled).toBe(true);
      c.toggleMeasurementSelection();
      expect(c.isMeasurementSelectionActive).toBe(false);
    } finally {
      button.remove();
    }
  });

  it("routes clicks in selection mode on shape bodies to selection and clears on mode changes", async () => {
    const { context: c, show } = setup();
    runInContext(readFileSync(resolve("src/map/editor/map-editor-shape-geometry.ts"), "utf8"), c);
    const handlers = new Map<string, (...args: any[]) => any>();
    const shape = {
      ...line(),
      on: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler),
    };
    c.openShapeMemoPopup = vi.fn();
    c.attachShapeEvents(shape);
    await handlers.get("click")!({ originalEvent: { ctrlKey: false } });
    expect(c.measurementSelectedShapes.has(shape)).toBe(true);
    expect(c.openShapeMemoPopup).not.toHaveBeenCalled();
    c.isMeasurementSelectionActive = false;
    await handlers.get("click")!({ originalEvent: { ctrlKey: false } });
    expect(c.openShapeMemoPopup).toHaveBeenCalledOnce();
    show();
    c.map.getContainer = () => document.createElement("div");
    c.clearShapeGeometryEditing = vi.fn();
    c.updateShapeVertexAddTargetStyles = vi.fn();
    c.setShapeGeometryEditingMode("edit");
    expect(c.measurementSelectedShapes.size).toBe(0);
    expect(c.isMeasurementVisible).toBe(true);
  });

  it("routes clicks in selection mode on names to selection without opening the name editor", () => {
    const { context: c } = setup();
    const element = document.createElement("div");
    c.L.DomEvent.on = (target: HTMLElement, name: string, handler: EventListener) =>
      target.addEventListener(name, handler);
    c.mapEditorProfile.shouldSuppressShapeLabelClick = () => false;
    c.openShapeNameEditor = vi.fn();
    const shape = { ...line(), getTooltip: () => ({ getElement: () => element }) };
    c.attachShapeNameTooltipClick(shape);
    element.dispatchEvent(new MouseEvent("click", { ctrlKey: false }));
    expect(c.measurementSelectedShapes.has(shape)).toBe(true);
    expect(c.openShapeNameEditor).not.toHaveBeenCalled();
    c.isMeasurementSelectionActive = false;
    element.dispatchEvent(new MouseEvent("click"));
    expect(c.openShapeNameEditor).toHaveBeenCalledOnce();
  });

  it("locks the type, toggles individual selections, and resets it after the last removal", () => {
    const { context: c, select } = setup();
    const a = line();
    const b = line();
    select(a);
    select(b);
    select(polygon());
    expect(c.measurementSelectedShapes.size).toBe(2);
    expect(c.setDrawStatus).toHaveBeenCalled();
    select(a);
    expect(c.measurementSelectedShapes.has(b)).toBe(true);
    select(b);
    expect(c.measurementSelectionType).toBeNull();
    expect(c.isMeasurementVisible).toBe(true);
    expect(c.isMeasurementSelectionActive).toBe(true);
    select(polygon("rectangle"));
    select(polygon());
    expect(c.measurementSelectedShapes.size).toBe(1);
    expect(c.measurementSelectionType).toBe("rectangle");
  });

  it("recalculates length while visible and retains the selected offscreen shapes", () => {
    const { context: c, select, show } = setup();
    const a = line();
    select(a);
    expect(show()).toContain("総延長 5.0 m");
    select(line());
    expect(c.measurementSummaryElement.textContent).toContain("総延長 10.0 m");
    c.pruneMeasurementSelection();
    expect(c.measurementSelectedShapes.size).toBe(2);
    select(a);
    expect(c.measurementSummaryElement.textContent).toContain("総延長 5.0 m");
  });

  it.each(["polygon", "rectangle"])("adds area and perimeter for %s", (type) => {
    const { select, show } = setup();
    select(polygon(type));
    select(polygon(type));
    expect(show()).toContain("面積 24 m²");
    expect(show()).toContain("周長 28.0 m");
  });

  it("sums raw circle areas before rounding and never displays a combined radius", () => {
    const { select, show } = setup();
    select({ shapeType: "circle", getRadius: () => 1 });
    select({ shapeType: "circle", getRadius: () => 2 });
    expect(show()).toContain("面積 16 m²");
    expect(show()).not.toContain("半径");
    expect(show()).not.toContain("周長");
  });

  it("preserves ordinary clicks, editing and drawing behavior", () => {
    const { context: c, select } = setup();
    c.isMeasurementSelectionActive = false;
    expect(c.handleMeasurementSelectionClick(line(), { ctrlKey: true })).toBe(false);
    c.isMeasurementSelectionActive = true;
    c.currentMapMode = "edit";
    expect(select(line())).toBe(false);
    c.currentMapMode = "view";
    c.activeDrawMode = "polygon";
    expect(select(line())).toBe(false);
    c.activeDrawMode = null;

    expect(c.measurementSelectedShapes.size).toBe(0);
  });

  it("toggles selection mode while keeping measurement enabled and updates the button", () => {
    const { context: c, select } = setup();
    const button = document.createElement("button");
    button.id = "measurement-selection-toggle-btn";
    document.body.append(button);
    try {
      select(line());
      c.toggleMeasurementSelection();
      expect(c.measurementSelectedShapes.size).toBe(0);
      expect(c.isMeasurementSelectionActive).toBe(false);
      expect(c.isMeasurementVisible).toBe(true);
      expect(button.getAttribute("aria-pressed")).toBe("false");
      expect(c.handleMeasurementSelectionClick(line(), { ctrlKey: true })).toBe(false);
      c.toggleMeasurementSelection();
      expect(button.getAttribute("aria-pressed")).toBe("true");
      select(polygon());
      expect(c.measurementSelectionType).toBe("polygon");
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      expect(c.measurementSelectedShapes.size).toBe(1);
      expect(c.handleMeasurementSelectionKeydown).toBeUndefined();
      c.isMeasurementVisible = false;
      c.clearMeasurementSelection();
      expect(button.classList.contains("is-hidden")).toBe(true);
    } finally {
      button.remove();
    }
  });

  it.each([false, true])(
    "shows only each selected line's total when multiple lines are selected (merged=%s)",
    (merged) => {
      const { context: c, select } = setup();
      c.isMeasurementSegmentMerged = merged;
      c.createMeasurementLabelMarker = (_point: unknown, lines: string[]) => ({ lines });
      c.createGroupedSegmentMeasurementMarkers = () => [{ lines: ["5.0 m"] }];
      c.createMeasurementVertexMarker = () => null;
      c.createGroupedSegmentEndpointMarkers = () => [];
      c.L.latLng = (lat: number, lng: number) => ({ lat, lng });
      const a = line();
      const b = line();
      select(a);
      expect(c.createShapeMeasurementMarkers(a).filter(Boolean)).toHaveLength(2);
      select(b);
      for (const shape of [a, b]) {
        expect(c.createShapeMeasurementMarkers(shape).filter(Boolean)).toEqual([
          { lines: ["総延長 5.0 m"] },
        ]);
      }
      select(b);
      expect(c.createShapeMeasurementMarkers(a).filter(Boolean)).toHaveLength(2);
    },
  );

  it("selects on mobile taps and ignores the synthetic click after touchend", () => {
    const { context: c } = setup();
    c.editorEntryProfile.isMobile = true;
    const shape = line();
    const tap = (type: string) =>
      c.handleMeasurementSelectionClick(shape, { type, originalEvent: { type } });
    tap("touchend");
    tap("click");
    expect(c.measurementSelectedShapes.has(shape)).toBe(true);
    tap("touchend");
    tap("click");
    expect(c.measurementSelectedShapes.size).toBe(0);
    expect(c.isMeasurementSelectionActive).toBe(true);
  });

  it("removes filtered or deleted shapes and clears measurement when none remain", () => {
    const { context: c, select, show } = setup();
    const a = { ...line(), hidden: false };
    const b = line();
    select(a);
    select(b);
    show();
    a.hidden = true;
    c.pruneMeasurementSelection();
    expect(c.measurementSummaryElement.textContent).toContain("線 1件");
    c.searchableShapeLayers.delete(b);
    c.pruneMeasurementSelection();
    expect(c.measurementSelectedShapes.size).toBe(0);
    expect(c.measurementSummaryElement.hidden).toBe(true);
  });

  it("removes stale individual labels as the selection changes, and restores all-shape measurement when unselected", () => {
    const { context: c, select } = setup();
    const a = { ...line(), getBounds: () => ({}) };
    const b = { ...line(), getBounds: () => ({}) };
    const layers = [a, b];
    const displayed = new Set();
    const viewport = createShapeViewportRuntime({
      getShapeRecords: () => [],
      scheduleFrame: () => 1,
      cancelFrame: () => {},
    });
    const manager = viewport.createViewportShapeMeasurementManager({
      map: {
        getBounds: () => ({ intersects: () => true }),
        on: () => {},
        off: () => {},
        hasLayer: () => true,
      } as any,
      getLayers: () => layers,
      attachMarkers: (layer) => {
        displayed.add(layer);
      },
      removeMarkers: (layer) => {
        displayed.delete(layer);
      },
      isLayerVisible: (layer) =>
        !c.isMeasurementSelectionActive || c.measurementSelectedShapes.has(layer),
    });
    c.shapeMeasurementManager = manager;
    c.isMeasurementSelectionActive = false;
    manager.setEnabled(true);
    manager.refresh();
    expect(displayed.size).toBe(2);
    c.toggleMeasurementSelection();
    manager.refresh();
    expect(displayed.size).toBe(0);
    select(a);
    manager.refresh();
    expect([...displayed]).toEqual([a]);
    select(b);
    manager.refresh();
    expect(displayed.size).toBe(2);
    c.clearMeasurementSelection();
    manager.refresh();
    expect(displayed.size).toBe(2);
    manager.setEnabled(true);
    manager.refresh();
    expect(displayed.size).toBe(2);
  });
});
