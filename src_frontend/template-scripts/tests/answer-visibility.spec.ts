import { describe, expect, it, vi } from "vitest";
import { createAnswerVisibility } from "../src/map/answer-visibility";
import { createLayeredMarkerDisplayManager } from "../src/map/common/search";

describe("answer and legend visibility masks", () => {
  it("keeps answer filters, layer choices and name search while the legend hides and restores objects", () => {
    const visible = new Set<object>();
    const group = {
      addLayer: (layer: object) => visible.add(layer),
      clearLayers: () => visible.clear(),
    };
    const layers = { a: {}, b: {} };
    const selectedLayers = new Set<object>([layers.a]);
    const markers = { "marker-a": {}, "marker-b": {}, "marker-c": {} };
    let rebuild = () => {};
    const masks = createAnswerVisibility(() => rebuild());
    const display = createLayeredMarkerDisplayManager({
      isRecordAllowed: (record) => masks.allows(`marker:${record.id}`),
      map: { hasLayer: (layer) => selectedLayers.has(layer) },
      markerRecords: {
        a: { id: "a", layer_id: "a", marker_name: "駅前" },
        b: { id: "b", layer_id: "b", marker_name: "駅北" },
        c: { id: "c", layer_id: "a", marker_name: "公園" },
      },
      markers,
      visibleMarkerGroup: group,
      layerVisibilityGroups: layers,
    });
    rebuild = display.rebuildVisibleMarkers;
    masks.setAnswerTargets(["marker:a", "marker:b"]);
    expect([...visible]).toEqual([markers["marker-a"]]);
    masks.setLegendHiddenTargets(["marker:a"]);
    expect(visible.size).toBe(0);
    selectedLayers.add(layers.b);
    display.rebuildVisibleMarkers();
    expect([...visible]).toEqual([markers["marker-b"]]);
    display.setSearchQuery("駅前");
    expect(visible.size).toBe(0);
    masks.setLegendHiddenTargets([]);
    expect([...visible]).toEqual([markers["marker-a"]]);
    display.clearSearch();
    expect([...visible]).toEqual([markers["marker-a"], markers["marker-b"]]);
    masks.setAnswerTargets([]);
    masks.setLegendHiddenTargets([]);
    expect(visible.size).toBe(0);
  });

  it("restores both masks if rebuilding fails", () => {
    const rebuild = vi.fn();
    const masks = createAnswerVisibility(rebuild);
    masks.setAnswerTargets(["marker:a"]);
    masks.setLegendHiddenTargets(["marker:a"]);
    rebuild.mockImplementationOnce(() => {
      throw Error("failed");
    });
    expect(() => masks.setLegendHiddenTargets([])).toThrow("failed");
    expect(masks.allows("marker:a")).toBe(false);
    expect(masks.allows("marker:b")).toBe(false);
  });
});
