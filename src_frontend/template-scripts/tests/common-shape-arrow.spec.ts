import { beforeEach, describe, expect, it, vi } from "vitest";

import { createShapeArrowRuntime } from "../src/map/common/shape-arrow";
import { createShapeStyleCore } from "../src/map/common/shape-style";

const defaults = {
  color: "#3388ff",
  fillOpacity: 0.2,
  weight: 5,
};
const style = createShapeStyleCore(() => defaults);

describe("map common shape arrow", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("creates one SVG marker for each normalized color", () => {
    const runtime = createRuntime();
    expect(runtime.ensureShapeArrowMarker("#F00")).toBe(
      "geocode-shape-arrowhead-ff0000",
    );
    expect(runtime.ensureShapeArrowMarker("#ff0000")).toBe(
      "geocode-shape-arrowhead-ff0000",
    );

    const markers = document.querySelectorAll(
      "#geocode-shape-arrowhead-ff0000",
    );
    expect(markers).toHaveLength(1);
    expect(markers[0]?.querySelector("path")?.getAttribute("fill")).toBe(
      "#ff0000",
    );
  });

  it("applies start and end arrow references to a polyline path", () => {
    const runtime = createRuntime();
    const path = document.createElementNS(
      "http://www.w3.org/2000/svg",
      "path",
    );
    path.setAttribute("stroke", "#ff0000");
    const layer = {
      _path: path,
      on: vi.fn(),
      shapeStyle: { arrowType: "both", color: "#ff0000" },
      shapeType: "polyline",
    };

    runtime.applyShapeArrowStyle(layer);
    const reference = "url(#geocode-shape-arrowhead-ff0000)";
    expect(path.getAttribute("marker-start")).toBe(reference);
    expect(path.getAttribute("marker-end")).toBe(reference);

    layer.shapeStyle.arrowType = "none";
    runtime.applyShapeArrowStyle(layer);
    expect(path.hasAttribute("marker-start")).toBe(false);
    expect(path.hasAttribute("marker-end")).toBe(false);
  });

  it("highlights a polyline on mouse hover and restores its style", () => {
    const listeners = new Map<string, () => void>();
    const setStyle = vi.fn();
    const restoreStyle = vi.fn();
    const layer = {
      on: (eventName: string, listener: () => void) => {
        listeners.set(eventName, listener);
      },
      options: { weight: 5 },
      setStyle,
      shapeStyle: { arrowType: "none", color: "#3388ff", weight: 5 },
      shapeType: "polyline",
    };
    const runtime = createRuntime(() => true);

    runtime.bindPolylineHoverHighlight(layer, { restoreStyle });
    listeners.get("mouseover")?.();
    expect(setStyle).toHaveBeenCalledWith({ weight: 9 });

    listeners.get("mouseout")?.();
    expect(restoreStyle).toHaveBeenCalledWith(layer);
    expect(
      (
        layer as typeof layer & {
          polylineHoverHighlightBound?: boolean;
        }
      ).polylineHoverHighlightBound,
    ).toBe(true);
  });

  it("does not highlight when a precise mouse is unavailable", () => {
    const listeners = new Map<string, () => void>();
    const setStyle = vi.fn();
    const runtime = createRuntime(() => false);
    runtime.bindPolylineHoverHighlight({
      on: (eventName, listener) => void listeners.set(eventName, listener),
      setStyle,
      shapeType: "polyline",
    });

    listeners.get("mouseover")?.();
    expect(setStyle).not.toHaveBeenCalled();
  });
});

function createRuntime(supportsMouseHover = () => true) {
  return createShapeArrowRuntime({
    getDefaultStyle: () => defaults,
    normalizeShapeArrowType: style.normalizeShapeArrowType,
    normalizeShapeColor: style.normalizeShapeColor,
    normalizeShapeWeight: style.normalizeShapeWeight,
    supportsMouseHover,
  });
}
