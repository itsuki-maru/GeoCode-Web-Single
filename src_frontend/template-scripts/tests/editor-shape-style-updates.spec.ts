import { createContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { runSource } from "./support/vm-source";

function setup() {
  const layers: any[] = [];
  const context = createContext({
    currentMapMode: "view",
    mapEditorProfile: { bindPolylineHoverHighlight: false },
    drawnShapesGroup: { eachLayer: vi.fn((callback) => layers.forEach(callback)) },
    clearMeasurementSelection: vi.fn(),
    updateMeasurementSelectionControl: vi.fn(),
    map: { getContainer: () => document.createElement("div") },
  });
  runSource(context, "src/map/editor/map-editor-shape-geometry.ts");
  // 図形の操作ハンドルの後処理は、カーソルのスタイルのライフサイクルを確認するこのテスト群の対象外とする。
  context.clearShapeGeometryEditing = vi.fn();
  const makeLayer = (shapeType = "polyline", properties: Record<string, unknown> = {}) => {
    const listeners = new Map<string, Array<() => void>>();
    let element: SVGPathElement | null = null;
    const layer = {
      shapeId: "shape-" + layers.length,
      shapeType,
      ...properties,
      getElement: vi.fn(() => element),
      on: (event: string, listener: () => void) => {
        const handlers = listeners.get(event) ?? [];
        handlers.push(listener);
        listeners.set(event, handlers);
      },
      add() {
        element = document.createElementNS("http://www.w3.org/2000/svg", "path");
        for (const listener of listeners.get("add") ?? []) listener();
        return element;
      },
      remove() {
        element = null;
      },
    };
    layers.push(layer);
    context.attachShapeEvents(layer);
    return layer;
  };
  return { context, layers, makeLayer };
}

describe("editor shape cursor-style updates", () => {
  it("updates each newly added shape once without walking existing shapes", () => {
    const { context, layers, makeLayer } = setup();
    context.currentMapMode = "input";
    for (let i = 0; i < 1000; i++) {
      const layer = makeLayer();
      expect(layer.getElement).not.toHaveBeenCalled();
      expect(layer.add().classList.contains("is-shape-vertex-add-target")).toBe(true);
    }
    expect(context.drawnShapesGroup.eachLayer).not.toHaveBeenCalled();
    expect(layers.reduce((total, layer) => total + layer.getElement.mock.calls.length, 0)).toBe(
      1000,
    );
  });

  it("synchronizes every displayed shape when input, edit, or view mode changes", () => {
    const { context, makeLayer } = setup();
    const line = makeLayer();
    const polygon = makeLayer("polygon");
    const rectangle = makeLayer("rectangle");
    const circle = makeLayer("circle");
    const restricted = makeLayer("polyline", { layerId: "locked" });
    const elements = [line, polygon, rectangle, circle, restricted].map((layer) => layer.add());
    for (const mode of ["input", "edit", "view"]) {
      context.setShapeGeometryEditingMode(mode);
      expect(
        elements.map((element) => element.classList.contains("is-shape-vertex-add-target")),
      ).toEqual(
        mode === "input" ? [true, true, true, false, true] : [false, false, false, false, false],
      );
    }
    expect(context.drawnShapesGroup.eachLayer).toHaveBeenCalledTimes(3);
  });

  it("uses the current mode and new SVG element when cached or restored shapes are added", () => {
    const { context, makeLayer } = setup();
    const restored = makeLayer("rectangle");
    const firstElement = restored.add();
    expect(firstElement.classList.contains("is-shape-vertex-add-target")).toBe(false);
    restored.remove();
    context.currentMapMode = "input";
    const readdedElement = restored.add();
    expect(readdedElement).not.toBe(firstElement);
    expect(readdedElement.classList.contains("is-shape-vertex-add-target")).toBe(true);
    restored.remove();
    context.currentMapMode = "edit";
    expect(restored.add().classList.contains("is-shape-vertex-add-target")).toBe(false);
    expect(context.drawnShapesGroup.eachLayer).not.toHaveBeenCalled();
  });

  it("ignores unavailable elements, unsaved shapes, and measurement labels", () => {
    const { context, makeLayer } = setup();
    context.currentMapMode = "input";
    const hidden = makeLayer();
    const unsaved = makeLayer("polyline", { shapeId: null });
    const measurement = makeLayer("polyline", { isMeasurementLabel: true });
    expect(() => context.updateShapeVertexAddTargetStyle(null)).not.toThrow();
    expect(() => context.updateShapeVertexAddTargetStyles()).not.toThrow();
    expect(hidden.getElement()).toBeNull();
    expect(unsaved.add().classList.contains("is-shape-vertex-add-target")).toBe(false);
    expect(measurement.add().classList.contains("is-shape-vertex-add-target")).toBe(false);
    expect(hidden.add().classList.contains("is-shape-vertex-add-target")).toBe(true);
  });
});
