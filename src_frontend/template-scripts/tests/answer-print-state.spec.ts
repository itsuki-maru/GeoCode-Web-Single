import { describe, expect, it } from "vitest";
import {
  createAnswerPrintSnapshot,
  isAnswerPrintSnapshot,
  MAX_ANSWER_PRINT_BYTES,
} from "../src/map/print/answer-print-state";

function fixture() {
  const state = {
    view: { latitude: 35, longitude: 139, zoom: 14 },
    tileServerId: "1",
    overlays: { rain: true },
    markersVisible: true,
    shapesVisible: true,
    shapeNamesVisible: false,
    layerIds: ["a"],
  };
  const marker = {
    id: "same",
    layer_id: "a",
    latitude: 35,
    longitude: 139,
    detail: "memo",
    marker_name: "facility",
  };
  const shape = {
    id: "same",
    layer_id: "a",
    shape_type: "circle",
    geojson: {
      type: "Feature",
      properties: { radius: 10 },
      geometry: { type: "Point", coordinates: [139, 35] },
    },
  };
  const bootstrap = {
    page: "form-answer-map",
    isCluster: true,
    initialView: state.view,
    tileServers: { "1": {} },
    tileOverlays: [],
    layers: { a: { id: "a" }, b: { id: "b" } },
    markers: { one: marker, excluded: { ...marker, id: "excluded", layer_id: "b" } },
    shapes: [shape],
    answerPreview: {
      query: { as_of: "2026-10-20T00:00:00Z" },
      targets: ["marker:same", "shape:same", "marker:excluded"],
      parentOrigin: location.origin,
      requestId: "r",
      answerCount: 3,
      targetCount: 3,
    },
  } as any;
  return { state, bootstrap, runtime: { getPrintState: () => state } };
}
describe("frozen answer print snapshot", () => {
  it("accepts 10,000 objects and rejects excess objects without truncation", () => {
    const f = fixture();
    f.bootstrap.shapes = [];
    f.bootstrap.markers = Object.fromEntries(
      Array.from({ length: 10001 }, (_, i) => [
        String(i),
        { ...f.bootstrap.markers.one, id: String(i) },
      ]),
    );
    const keys = Object.keys(f.bootstrap.markers).map((id) => `marker:${id}`);
    expect(() => createAnswerPrintSnapshot(f.bootstrap, f.runtime, keys)).toThrow();
    expect(
      createAnswerPrintSnapshot(f.bootstrap, f.runtime, keys.slice(0, 10000)).bootstrap
        .answerPreview.targets,
    ).toHaveLength(10000);
  });
  it("keeps only visible targets, distinguishes marker/shape IDs and preserves the view", () => {
    const f = fixture();
    const s = createAnswerPrintSnapshot(f.bootstrap, f.runtime, ["marker:same", "shape:same"]);
    expect(isAnswerPrintSnapshot(s)).toBe(true);
    expect(Object.keys(s.bootstrap.markers)).toEqual(["one"]);
    expect(s.bootstrap.shapes).toHaveLength(1);
    expect(Object.keys(s.bootstrap.layers)).toEqual(["a"]);
    expect(s.state).toEqual(f.state);
    f.bootstrap.markers.one.detail = "changed";
    f.state.view.zoom = 18;
    expect(s.bootstrap.markers.one.detail).toBe("memo");
    expect(s.state.view.zoom).toBe(14);
  });
  it("rejects zero, missing objects, duplicates, invalid state and excessive payloads", () => {
    const f = fixture();
    for (const keys of [[], ["marker:missing"], ["marker:same", "marker:same"]])
      expect(() => createAnswerPrintSnapshot(f.bootstrap, f.runtime, keys)).toThrow();
    const s = createAnswerPrintSnapshot(f.bootstrap, f.runtime, ["marker:same"]);
    s.state.view.latitude = 999;
    expect(isAnswerPrintSnapshot(s)).toBe(false);
    s.state.view.latitude = 35;
    s.bootstrap.markers.one.detail = "x".repeat(MAX_ANSWER_PRINT_BYTES);
    expect(isAnswerPrintSnapshot(s)).toBe(false);
  });
});
