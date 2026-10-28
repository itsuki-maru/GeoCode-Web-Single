import { describe, expect, it } from "vitest";
import { readMapBootstrap } from "../src/map/bootstrap";
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
  it("requires canonical bodies in both the snapshot sender and receiver", () => {
    const f = fixture();
    f.bootstrap.markers = {};
    f.bootstrap.popupBodies = { "shape:same": {
      free_text: "自由𠮷\r\n", managed_markdown: "**全回答🙂**", sync_required: false,
    } };
    f.bootstrap.normalBodyReferences = { version: 1, markers: [], shapes: ["same"] };
    f.bootstrap.answerPreview.targets = ["shape:same"];
    f.bootstrap.answerPreview.targetCount = 1;
    expect(isAnswerPrintSnapshot({ state: f.state, bootstrap: f.bootstrap })).toBe(false);
    expect(() => createAnswerPrintSnapshot(f.bootstrap, f.runtime, ["shape:same"])).toThrow("印刷対象が不正です");
    delete window.__GEOCODE_MAP_BOOTSTRAP__;
    const node = document.createElement("script");
    node.id = "geocode-map-bootstrap";
    node.type = "application/json";
    node.textContent = JSON.stringify(f.bootstrap);
    document.body.append(node);
    try {
      const canonical = readMapBootstrap();
      if (canonical.page !== "form-answer-map") throw Error("Wrong page");
      const snapshot = createAnswerPrintSnapshot(canonical, f.runtime, ["shape:same"]);
      expect(snapshot.bootstrap.shapes[0].geojson.properties).toEqual({
        radius: 10, memo: "自由𠮷\r\n**全回答🙂**",
      });
      expect(snapshot.bootstrap).not.toHaveProperty("normalBodyReferences");
      expect(isAnswerPrintSnapshot(snapshot)).toBe(true);
    } finally {
      node.remove();
      delete window.__GEOCODE_MAP_BOOTSTRAP__;
    }
  });

  it("applies the 32MiB byte cap after restoring the full Unicode body", () => {
    const f = fixture();
    f.bootstrap.markers = {};
    const text = "界".repeat(Math.floor(MAX_ANSWER_PRINT_BYTES / 6) + 1);
    f.bootstrap.popupBodies = { "shape:same": {
      free_text: text, managed_markdown: "", sync_required: false,
    } };
    f.bootstrap.normalBodyReferences = { version: 1, markers: [], shapes: ["same"] };
    f.bootstrap.answerPreview.targets = ["shape:same"];
    f.bootstrap.answerPreview.targetCount = 1;
    const compact = JSON.stringify(f.bootstrap);
    expect(new TextEncoder().encode(compact).length).toBeLessThan(MAX_ANSWER_PRINT_BYTES);
    delete window.__GEOCODE_MAP_BOOTSTRAP__;
    const node = document.createElement("script");
    node.id = "geocode-map-bootstrap";
    node.type = "application/json";
    node.textContent = compact;
    document.body.append(node);
    try {
      const canonical = readMapBootstrap();
      if (canonical.page !== "form-answer-map") throw Error("Wrong page");
      expect((canonical.shapes[0].geojson.properties as any).memo).toBe(text);
      // Both the restored normal body and the complete popup projection belong
      // to print. The compact wire representation cannot bypass the byte cap.
      expect(() => createAnswerPrintSnapshot(canonical, f.runtime, ["shape:same"])).toThrow("32MiB");
    } finally {
      node.remove();
      delete window.__GEOCODE_MAP_BOOTSTRAP__;
    }
  });

  it("includes coloring only when used, restricts it to print targets and freezes applied colors", () => {
    const f = fixture();
    expect(createAnswerPrintSnapshot(f.bootstrap, f.runtime, ["marker:same"])).not.toHaveProperty(
      "coloring",
    );
    const coloring = {
      version: 1,
      rules: [{ id: "r", label: "分類", color: "#ff0000" }],
      targets: { "marker:same": "r", "shape:same": "r", "marker:excluded": "r" },
    };
    (f.runtime as any).answerColoring = { getState: () => coloring };
    const snapshot = createAnswerPrintSnapshot(f.bootstrap, f.runtime, ["marker:same"]);
    expect(snapshot.coloring!.targets).toEqual({ "marker:same": "r" });
    coloring.rules[0].color = "#00ff00";
    expect(snapshot.coloring!.rules[0].color).toBe("#ff0000");
    snapshot.coloring!.targets["shape:same"] = "r";
    expect(isAnswerPrintSnapshot(snapshot)).toBe(false);
    delete snapshot.coloring!.targets["shape:same"];
    snapshot.coloring!.targets["marker:same"] = "unknown";
    expect(isAnswerPrintSnapshot(snapshot)).toBe(false);
    snapshot.coloring!.targets["marker:same"] = "r";
    snapshot.coloring!.rules[0].color = "url(javascript:alert(1))";
    expect(isAnswerPrintSnapshot(snapshot)).toBe(false);
  });
  it("freezes popup sections and analysis for only the selected objects", () => {
    const f = fixture();
    const body = { free_text: "自由", managed_markdown: "回答", sync_required: false };
    f.bootstrap.popupBodies = { "marker:same": body, "marker:excluded": body };
    (f.runtime as any).popupContent = {
      getAnalysis: () => ({ "marker:same": "分析値", "marker:excluded": "除外" }),
    };
    const snapshot = createAnswerPrintSnapshot(f.bootstrap, f.runtime, ["marker:same"]);
    expect(snapshot.bootstrap.popupBodies).toEqual({ "marker:same": body });
    expect(snapshot.bootstrap.popupAnalysis).toEqual({ "marker:same": "分析値" });
    body.free_text = "変更後";
    expect(snapshot.bootstrap.popupBodies!["marker:same"].free_text).toBe("自由");
    snapshot.bootstrap.popupBodies!["marker:foreign"] = body;
    expect(isAnswerPrintSnapshot(snapshot)).toBe(false);
  });
  it("2万対象と全popup情報を件数で省略せず固定し、所属と重複を検証する", () => {
    const f = fixture();
    f.bootstrap.shapes = [];
    f.bootstrap.markers = Object.fromEntries(
      Array.from({ length: 20_000 }, (_, i) => [
        String(i),
        { ...f.bootstrap.markers.one, id: String(i) },
      ]),
    );
    const keys = Object.keys(f.bootstrap.markers).map((id) => `marker:${id}`);
    const body = { free_text: "自由", managed_markdown: "回答", sync_required: false };
    f.bootstrap.popupBodies = Object.fromEntries(keys.map((key) => [key, body]));
    f.bootstrap.popupAnalysis = Object.fromEntries(keys.map((key) => [key, "分析値"]));
    (f.runtime as any).popupContent = { getAnalysis: () => f.bootstrap.popupAnalysis };
    const snapshot = createAnswerPrintSnapshot(f.bootstrap, f.runtime, keys);
    const printTargets = snapshot.bootstrap.answerPreview.targets;
    if (!printTargets) throw new Error("印刷対象がありません。");
    expect(printTargets).toHaveLength(keys.length);
    expect(Object.keys(snapshot.bootstrap.popupBodies!)).toHaveLength(keys.length);
    expect(Object.keys(snapshot.bootstrap.popupAnalysis!)).toHaveLength(keys.length);
    expect(isAnswerPrintSnapshot(snapshot)).toBe(true);
    snapshot.bootstrap.popupAnalysis!["marker:outside"] = "対象外";
    expect(isAnswerPrintSnapshot(snapshot)).toBe(false);
    delete snapshot.bootstrap.popupAnalysis!["marker:outside"];
    printTargets[1] = printTargets[0];
    expect(isAnswerPrintSnapshot(snapshot)).toBe(false);
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
