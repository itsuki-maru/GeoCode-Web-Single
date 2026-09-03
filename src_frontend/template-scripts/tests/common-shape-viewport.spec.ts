import { describe, expect, it, vi } from "vitest";

import { createShapeViewportRuntime } from "../src/map/common/shape-viewport";

describe("map common shape viewport", () => {
  it("suppresses initial rendering only above the configured threshold", () => {
    const { runtime } = createRuntime();

    expect(runtime.shouldSuppressInitialShapeRendering(new Array(400))).toBe(
      false,
    );
    expect(runtime.shouldSuppressInitialShapeRendering(new Array(401))).toBe(
      true,
    );
    expect(
      runtime.shouldSuppressInitialShapeRendering({ a: {}, b: {} }, 1),
    ).toBe(true);
  });

  it("binds labels only at a detailed zoom and inside the viewport", () => {
    let zoom = 7;
    const inside = createLabelLayer(true);
    const outside = createLabelLayer(false);
    const bindLabel = vi.fn((layer: ReturnType<typeof createLabelLayer>) => {
      layer.tooltip = {};
    });
    const map = createMap({
      contains: (point) => Boolean((point as { inside?: boolean }).inside),
      getZoom: () => zoom,
    });
    const { runtime } = createRuntime();
    const manager = runtime.createViewportShapeLabelManager({
      bindLabel,
      getLabelLatLng: (layer) =>
        (layer as ReturnType<typeof createLabelLayer>).point,
      getLayers: () => [inside, outside],
      map,
    });

    manager.refresh();
    expect(bindLabel).not.toHaveBeenCalled();

    zoom = 8;
    manager.refresh();
    expect(bindLabel).toHaveBeenCalledExactlyOnceWith(inside, inside.point);
    expect(inside.openTooltip).toHaveBeenCalledOnce();
    expect(outside.openTooltip).not.toHaveBeenCalled();
  });

  it("shows a focused named layer even when ordinary labels are disabled", () => {
    const focused = createLabelLayer(true, "避難経路");
    const bindLabel = vi.fn(() => {
      focused.tooltip = {};
    });
    const { runtime } = createRuntime();
    const manager = runtime.createViewportShapeLabelManager({
      bindLabel,
      enabled: false,
      getLabelLatLng: () => focused.point,
      getLayers: () => [focused],
      map: createMap(),
    });

    manager.setFocusedLayer(focused);
    expect(bindLabel).toHaveBeenCalledExactlyOnceWith(focused, focused.point);
    expect(focused.openTooltip).toHaveBeenCalledOnce();

    manager.setFocusedLayer(null);
    expect(focused.unbindTooltip).toHaveBeenCalledOnce();
  });

  it("attaches measurements only to visible intersecting layers", () => {
    const inside = { getBounds: () => ({ inside: true }) };
    const outside = { getBounds: () => ({ inside: false }) };
    const hidden = { getBounds: () => ({ inside: true }) };
    const attachMarkers = vi.fn();
    const removeMarkers = vi.fn();
    const map = createMap({
      hasLayer: (layer) => layer !== hidden,
      intersects: (bounds) => Boolean((bounds as { inside?: boolean }).inside),
    });
    const { runtime } = createRuntime();
    const manager = runtime.createViewportShapeMeasurementManager({
      attachMarkers,
      getLayers: () => [inside, outside, hidden],
      map,
      removeMarkers,
    });

    manager.refresh();
    expect(attachMarkers).not.toHaveBeenCalled();

    manager.setEnabled(true);
    manager.refresh();
    expect(attachMarkers).toHaveBeenCalledExactlyOnceWith(
      inside,
      expect.any(Object),
    );
    expect(removeMarkers).toHaveBeenCalledWith(inside);
    expect(removeMarkers).toHaveBeenCalledWith(outside);
    expect(removeMarkers).toHaveBeenCalledWith(hidden);
  });

  it("coalesces refresh requests and pauses them during zoom", () => {
    const scheduledCallbacks: Array<() => void> = [];
    const scheduleFrame = vi.fn((callback: () => void) => {
      scheduledCallbacks.push(callback);
      return scheduledCallbacks.length;
    });
    const handlers = new Map<string, () => void>();
    const layer = createLabelLayer(true);
    const map = createMap({ handlers });
    const { runtime } = createRuntime({ scheduleFrame });
    const manager = runtime.createViewportShapeLabelManager({
      bindLabel: () => {
        layer.tooltip = {};
      },
      getLabelLatLng: () => layer.point,
      getLayers: () => [layer],
      map,
    });

    manager.scheduleRefresh();
    manager.scheduleRefresh();
    expect(scheduleFrame).toHaveBeenCalledOnce();

    handlers.get("zoomstart")?.();
    manager.scheduleRefresh();
    expect(scheduleFrame).toHaveBeenCalledOnce();

    handlers.get("zoomend")?.();
    expect(scheduleFrame).toHaveBeenCalledTimes(2);
  });
});

function createRuntime({
  scheduleFrame = vi.fn(() => 1),
}: { scheduleFrame?: (callback: () => void) => number } = {}) {
  const runtime = createShapeViewportRuntime({
    cancelFrame: vi.fn(),
    getShapeRecords: (records) => {
      if (Array.isArray(records)) return records;
      return records && typeof records === "object"
        ? Object.values(records)
        : [];
    },
    scheduleFrame,
  });
  return { runtime };
}

function createLabelLayer(inside: boolean, shapeName = "図形") {
  return {
    closeTooltip: vi.fn(),
    getTooltip: vi.fn(function (this: { tooltip: object | null }) {
      return this.tooltip;
    }),
    openTooltip: vi.fn(),
    point: { inside },
    shapeName,
    tooltip: null as object | null,
    unbindTooltip: vi.fn(function (this: { tooltip: object | null }) {
      this.tooltip = null;
    }),
  };
}

function createMap({
  contains = () => true,
  getZoom = () => 16,
  handlers = new Map<string, () => void>(),
  hasLayer = () => true,
  intersects = () => true,
}: {
  contains?: (value: unknown) => boolean;
  getZoom?: () => number;
  handlers?: Map<string, () => void>;
  hasLayer?: (layer: object) => boolean;
  intersects?: (value: unknown) => boolean;
} = {}) {
  return {
    getBounds: () => ({ contains, intersects }),
    getZoom,
    hasLayer,
    off: vi.fn(),
    on: vi.fn((eventNames: string, listener: () => void) => {
      handlers.set(eventNames, listener);
    }),
  };
}
