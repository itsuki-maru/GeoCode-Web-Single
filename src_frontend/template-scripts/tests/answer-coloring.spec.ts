import { describe, expect, it, vi } from "vitest";
import {
  installAnswerColoring,
  isAnswerColoring,
  type AnswerColoring,
} from "../src/map/answer-coloring";
import { createShapeArrowRuntime } from "../src/map/common/shape-arrow";
import { createShapeStyleCore } from "../src/map/common/shape-style";

function setup() {
  const icon = { iconUrl: "/custom.png" };
  const marker = {
    options: { icon: icon as any },
    setIcon: vi.fn(function (this: any, value: unknown) {
      this.options.icon = value;
    }),
  };
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  const handlers: Record<string, () => void> = {};
  const shape = {
    shapeStyle: { color: "#123456", weight: 3, dashArray: "1,6", arrowType: "both" },
    shapeType: "polyline",
    options: { color: "#123456", weight: 3, fillColor: null },
    _path: path,
    on: vi.fn((name: string, handler: () => void) => {
      handlers[name] = handler;
    }),
    setStyle: vi.fn(function (this: any, style: any) {
      Object.assign(this.options, style);
      if (style.color) path.setAttribute("stroke", style.color);
    }),
  };
  const defaultStyle = () => ({ color: "#123456", weight: 3, fillOpacity: 0.2 });
  const styles = createShapeStyleCore(defaultStyle);
  const arrows = createShapeArrowRuntime({
    getDefaultStyle: defaultStyle,
    normalizeShapeArrowType: styles.normalizeShapeArrowType,
    normalizeShapeColor: styles.normalizeShapeColor,
    normalizeShapeWeight: styles.normalizeShapeWeight,
    supportsMouseHover: () => true,
  });
  arrows.bindPolylineHoverHighlight(shape, {
    restoreStyle: (layer) => shape.setStyle(layer.shapeStyle),
  });
  const originalCluster = vi.fn();
  const runtime = {
    markers: { "marker-same": marker },
    shapeLayers: { "shape-same": shape },
    visibleMarkerGroup: {
      options: { iconCreateFunction: originalCluster },
      refreshClusters: vi.fn(),
    },
    applyShapeArrowStyle: vi.fn(arrows.applyShapeArrowStyle),
    shapeNameLabelManager: { invalidate: vi.fn() },
    map: { on: vi.fn(), off: vi.fn(), fitBounds: vi.fn() },
  };
  const leaflet = { divIcon: vi.fn((options: any) => options) };
  const state: AnswerColoring = {
    version: 1,
    rules: [{ id: "a", label: "対象<script>", color: "#0072b2" }],
    targets: { "marker:same": "a", "shape:same": "a" },
  };
  return { runtime, leaflet, marker, shape, path, handlers, state, icon, originalCluster };
}

describe("answer map coloring", () => {
  it("validates colors, references, scope, target kinds and bounded rules", () => {
    const s = setup();
    expect(isAnswerColoring(s.state, new Set(["marker:same", "shape:same"]))).toBe(true);
    expect(isAnswerColoring(s.state, new Set(["marker:same"]))).toBe(false);
    expect(isAnswerColoring({ ...s.state, targets: { "marker:same": "missing" } })).toBe(false);
    expect(isAnswerColoring({ ...s.state, targets: { "layer:same": "a" } })).toBe(false);
    expect(isAnswerColoring({ ...s.state, rules: [...s.state.rules, ...s.state.rules] })).toBe(
      false,
    );
    expect(
      isAnswerColoring({ ...s.state, rules: [{ ...s.state.rules[0], color: "red;display:none" }] }),
    ).toBe(false);
    expect(isAnswerColoring({ ...s.state, rules: [] })).toBe(false);
    expect(
      isAnswerColoring({
        ...s.state,
        rules: Array.from({ length: 21 }, (_, i) => ({ id: `${i}`, label: "a", color: "#123456" })),
      }),
    ).toBe(false);
  });

  it("updates marker, line, arrow, hover and label colors then restores original styles", () => {
    const s = setup();
    const controller = installAnswerColoring(s.runtime, s.leaflet);
    controller.apply(s.state);
    expect(s.marker.options.icon.html).toContain("background:#0072b2");
    expect(s.marker.options.icon.html).not.toContain("<script>");
    expect(s.shape.shapeStyle).toEqual({
      color: "#0072b2",
      fillColor: "#0072b2",
      weight: 3,
      dashArray: "1,6",
      arrowType: "both",
    });
    expect(s.path.getAttribute("marker-end")).toContain("0072b2");
    s.handlers.mouseover();
    s.handlers.mouseout();
    expect(s.shape.options.color).toBe("#0072b2");
    expect(s.shape.options.weight).toBe(3);
    expect(s.runtime.shapeNameLabelManager.invalidate).toHaveBeenCalledWith(s.shape);
    expect(s.runtime.visibleMarkerGroup.options.iconCreateFunction).toBe(s.originalCluster);
    expect(s.runtime.visibleMarkerGroup.refreshClusters).toHaveBeenCalled();
    controller.apply(null);
    expect(s.marker.options.icon).toBe(s.icon);
    expect(s.shape.shapeStyle).toEqual({
      color: "#123456",
      weight: 3,
      dashArray: "1,6",
      arrowType: "both",
    });
    expect(s.shape.options.fillColor).toBeNull();
    expect(s.path.getAttribute("marker-end")).toContain("123456");
    expect(s.runtime.visibleMarkerGroup.options.iconCreateFunction).toBe(s.originalCluster);
    expect(s.runtime.map.fitBounds).not.toHaveBeenCalled();
  });

  it("preserves cluster rendering through recoloring, clearing, rollback and disposal", () => {
    const s = setup();
    // Styling may be supplied by Leaflet or another caller; coloring must never
    // write its options, including when restoring a previous coloring state.
    Object.freeze(s.runtime.visibleMarkerGroup.options);
    const controller = installAnswerColoring(s.runtime, s.leaflet);
    const expectRendererPreserved = () =>
      expect(s.runtime.visibleMarkerGroup.options.iconCreateFunction).toBe(s.originalCluster);
    controller.apply(s.state);
    expectRendererPreserved();
    controller.apply({
      ...s.state,
      rules: [{ ...s.state.rules[0], color: "#ff0000" }],
    });
    expectRendererPreserved();
    expect(s.marker.options.icon.html).toContain("#ff0000");
    controller.apply(null);
    expectRendererPreserved();
    expect(s.marker.options.icon).toBe(s.icon);
    controller.apply(s.state);
    s.shape.setStyle.mockImplementationOnce(() => {
      throw Error("render failure");
    });
    expect(() => controller.apply(null)).toThrow("render failure");
    expectRendererPreserved();
    expect(controller.getState()).toEqual(s.state);
    controller.dispose();
    expectRendererPreserved();
    expect(s.marker.options.icon).toBe(s.icon);
  });

  it("isolates the applied state and restores objects that leave a classification", () => {
    const s = setup();
    const controller = installAnswerColoring(s.runtime, s.leaflet);
    controller.apply(s.state);
    s.state.rules[0].color = "#ffffff";
    const copy = controller.getState()!;
    expect(copy.rules[0].color).toBe("#0072b2");
    copy.targets = {};
    expect(controller.getState()!.targets["marker:same"]).toBe("a");
    controller.apply({ ...s.state, targets: { "shape:same": "a", "marker:no-position": "a" } });
    expect(s.marker.options.icon).toBe(s.icon);
    expect(s.shape.options.color).toBe("#ffffff");
    controller.dispose();
    expect(controller.getState()).toBeNull();
    expect(s.shape.options.color).toBe("#123456");
    expect(s.runtime.map.off).toHaveBeenCalledWith("unload", controller.dispose);
  });

  it("keeps the previous applied state after a rendering failure", () => {
    const s = setup();
    const controller = installAnswerColoring(s.runtime, s.leaflet);
    controller.apply(s.state);
    s.shape.setStyle.mockImplementationOnce(() => {
      throw Error("render failure");
    });
    expect(() => controller.apply(null)).toThrow("render failure");
    expect(controller.getState()).toEqual(s.state);
    expect(s.marker.options.icon.html).toContain("#0072b2");
    expect(s.shape.options.color).toBe("#0072b2");
    expect(() => controller.apply({ ...s.state, targets: { "shape:same": "unknown" } })).toThrow();
    expect(controller.getState()).toEqual(s.state);
  });
});
