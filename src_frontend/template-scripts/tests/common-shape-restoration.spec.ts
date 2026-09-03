import { describe, expect, it, vi } from "vitest";

import { getShapeRecords } from "../src/map/common/search";
import { createReadOnlyShapeRestorationRuntime } from "../src/map/common/shape-restoration";

type Dependencies = Parameters<typeof createReadOnlyShapeRestorationRuntime>[0];

function createDependencies(overrides: Partial<Dependencies> = {}) {
  const attachShapeMemoPopup = vi.fn();
  const attachShapeMemoTooltipOpen = vi.fn();
  const bindPolylineHoverHighlight = vi.fn();
  const createLeafletShapeLayer = vi.fn(() => ({}));
  const dependencies: Dependencies = {
    attachShapeMemoPopup,
    attachShapeMemoTooltipOpen,
    bindPolylineHoverHighlight,
    createLeafletShapeLayer,
    escapeHtml: (value) => value.replaceAll("<", "&lt;"),
    getDefaultShapeColor: () => "#3388ff",
    getShapeMemoFromGeoJson: () => "saved memo",
    getShapeNameLabelManager: () => null,
    getShapeRecords,
    getShapeStyleFromGeoJson: () => ({ color: "#123456", weight: 4 }),
    normalizeShapeColor: (value, fallback) => String(value || fallback),
    normalizeShapeName: (value) => String(value ?? "").trim(),
    scheduleTask: (callback) => callback(),
    ...overrides,
  };
  return {
    attachShapeMemoPopup,
    attachShapeMemoTooltipOpen,
    bindPolylineHoverHighlight,
    createLeafletShapeLayer,
    dependencies,
  };
}

describe("read-only shape restoration runtime", () => {
  it("restores object-based saved shapes and registers their metadata", () => {
    const setStyle = vi.fn();
    const unbindTooltip = vi.fn();
    const layer = { setStyle, unbindTooltip };
    const { dependencies, attachShapeMemoPopup, bindPolylineHoverHighlight } =
      createDependencies({ createLeafletShapeLayer: vi.fn(() => layer) });
    const runtime = createReadOnlyShapeRestorationRuntime(dependencies);
    const shapeLayers: Record<string, object> = {};
    const addLayer = vi.fn();
    const geojson = { type: "Feature" };

    const restored = runtime.restoreSavedShapes({
      addLayer,
      applyShapeStyle: true,
      bindPolylineHover: true,
      records: {
        first: {
          geojson,
          id: 42,
          layer_id: "layer-1",
          name: "  Area A  ",
          shape_type: "polygon",
        },
      },
      restoreShapeStyleOnHover: true,
      shapeLayers,
    });

    expect(restored).toBe(true);
    expect(layer).toMatchObject({
      isShapeNameLayer: true,
      layerId: "layer-1",
      shapeId: 42,
      shapeMemo: "saved memo",
      shapeName: "Area A",
      shapeStyle: { color: "#123456", weight: 4 },
      shapeType: "polygon",
    });
    expect(shapeLayers["shape-42"]).toBe(layer);
    expect(setStyle).toHaveBeenCalledWith({ color: "#123456", weight: 4 });
    expect(attachShapeMemoPopup).toHaveBeenCalledWith(layer);
    expect(bindPolylineHoverHighlight).toHaveBeenCalledWith(
      layer,
      expect.objectContaining({ restoreStyle: expect.any(Function) }),
    );
    expect(addLayer).toHaveBeenCalledWith(layer, "layer-1");
  });

  it("skips invalid records and reports when no shape was restored", () => {
    const { dependencies, createLeafletShapeLayer } = createDependencies();
    const runtime = createReadOnlyShapeRestorationRuntime(dependencies);

    expect(
      runtime.restoreSavedShapes({
        addLayer: vi.fn(),
        records: [{ id: 1 }, { id: 2, shape_type: "unsupported" }],
        shapeLayers: {},
      }),
    ).toBe(true);
    expect(createLeafletShapeLayer).toHaveBeenCalledOnce();

    const emptyRuntime = createReadOnlyShapeRestorationRuntime({
      ...dependencies,
      createLeafletShapeLayer: () => null,
    });
    expect(
      emptyRuntime.restoreSavedShapes({
        addLayer: vi.fn(),
        records: [{ id: 3, shape_type: "polygon" }],
        shapeLayers: {},
      }),
    ).toBe(false);
  });

  it("binds the plain temporary-map label and opens its memo interaction", () => {
    const tooltipElement = document.createElement("div");
    const tooltip = {
      getElement: () => tooltipElement,
      setLatLng: vi.fn(),
    };
    const layer = {
      bindTooltip: vi.fn(),
      getTooltip: () => tooltip,
      openTooltip: vi.fn(),
      shapeName: "<Area>",
      shapeStyle: { color: "#123456" },
    };
    const { dependencies, attachShapeMemoTooltipOpen } = createDependencies();
    const runtime = createReadOnlyShapeRestorationRuntime(dependencies);
    const labelLatLng = { lat: 1, lng: 2 };

    runtime.bindShapeNameLabelTooltip(layer, labelLatLng);

    expect(layer.bindTooltip).toHaveBeenCalledWith(
      '<div class="shape-name-label" style="color:#123456;">&lt;Area></div>',
      {
        className: "shape-name-tooltip",
        direction: "center",
        interactive: true,
        permanent: true,
      },
    );
    expect(tooltip.setLatLng).toHaveBeenCalledWith(labelLatLng);
    expect(layer.openTooltip).toHaveBeenCalledOnce();
    expect(tooltipElement.style.getPropertyValue("border-color")).toBe(
      "rgb(18, 52, 86)",
    );
    expect(attachShapeMemoTooltipOpen).toHaveBeenCalledWith(
      layer,
      labelLatLng,
    );
  });

  it("preserves the pill label appearance used by map-anather", () => {
    const tooltipElement = document.createElement("div");
    const layer = {
      bindTooltip: vi.fn(),
      getTooltip: () => ({ getElement: () => tooltipElement }),
      shapeName: "",
      shapeStyle: { color: "#654321" },
    };
    const { dependencies } = createDependencies({ labelAppearance: "pill" });
    const runtime = createReadOnlyShapeRestorationRuntime(dependencies);

    runtime.bindShapeNameLabelTooltip(layer, null);

    expect(layer.bindTooltip.mock.calls[0]?.[0]).toContain(
      'class="shape-name-label is-empty"',
    );
    expect(layer.bindTooltip.mock.calls[0]?.[0]).toContain("&nbsp;");
    expect(tooltipElement.style.getPropertyValue("background")).toBe(
      "transparent",
    );
    expect(tooltipElement.style.getPropertyPriority("border")).toBe(
      "important",
    );
  });

  it("invalidates an existing label manager when a shape name changes", () => {
    const invalidate = vi.fn();
    const { dependencies } = createDependencies({
      getShapeNameLabelManager: () => ({ invalidate }),
    });
    const runtime = createReadOnlyShapeRestorationRuntime(dependencies);
    const layer = {};

    runtime.updateShapeNameLabel(layer, "  Updated  ");

    expect(layer).toMatchObject({
      isShapeNameLayer: true,
      shapeName: "Updated",
    });
    expect(invalidate).toHaveBeenCalledWith(layer);
  });
});
