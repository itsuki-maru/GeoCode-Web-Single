import { beforeEach, describe, expect, it, vi } from "vitest";

import { readMapBootstrap } from "../src/map/bootstrap";
import { restoreNormalBodyReferences } from "../src/map/normal-body-references";

const records = {
  layers: {},
  markers: {},
  tileServers: {},
};

const answerData = () => ({
  ...records,
  page: "form-answer-map",
  isCluster: true,
  initialView: { latitude: 35, longitude: 139, zoom: 14 },
  shapes: [],
  popupBodies: {},
  answerPreview: {
    answerCount: 3,
    targetCount: 0,
    parentOrigin: "http://localhost",
    requestId: "json-bootstrap",
    query: { mode: "history", as_of: "2026-10-01T00:00:00Z" },
    targets: [],
  },
});

function jsonBlock(value: unknown, raw = false) {
  const script = document.createElement("script");
  script.id = "geocode-map-bootstrap";
  script.type = "application/json";
  script.textContent = raw ? String(value) : JSON.stringify(value);
  document.body.append(script);
  return script;
}

function referencedData(): any {
  return {
    ...answerData(),
    markers: { same: { id: "same", marker_name: "施設🙂", latitude: 35, longitude: 139 } },
    shapes: [
      { id: "same", name: "図形𠮷", shape_type: "circle", geojson: {
        type: "Feature", properties: { radius: 12, normalBodyReferences: "user data" },
        geometry: { type: "Point", coordinates: [139, 35] },
      } },
      { id: "fallback", name: "順序が異なる旧本文", geojson: { properties: { memo: "回答→自由" } } },
    ],
    popupBodies: {
      "marker:same": { free_text: "自由𠮷e\u0301\r\n\"\\</script>&", managed_markdown: "**回答🙂**\u2028\u2029", sync_required: false },
      "shape:same": { free_text: "", managed_markdown: "全回答🗾\n", sync_required: true },
      "shape:fallback": { free_text: "自由", managed_markdown: "回答", sync_required: true },
    },
    normalBodyReferences: { version: 1, markers: ["same"], shapes: ["same"] },
    answerPreview: {
      ...answerData().answerPreview,
      targetCount: 3,
      targets: ["shape:fallback", "marker:same", "shape:same"],
    },
  };
}

describe("readMapBootstrap", () => {
  beforeEach(() => {
    delete window.__GEOCODE_MAP_BOOTSTRAP__;
    document.body.replaceChildren();
  });

  it.each(["map", "map-mobile"] as const)("reads %s bootstrap data", (page) => {
    window.__GEOCODE_MAP_BOOTSTRAP__ = {
      ...records,
      initialView: { latitude: 35, longitude: 139, zoom: 8 },
      isMaster: true,
      markerId: "0",
      page,
      selectedLayer: "None",
      shapes: [],
    };

    expect(readMapBootstrap().page).toBe(page);
  });

  it("reads another-window bootstrap data", () => {
    window.__GEOCODE_MAP_BOOTSTRAP__ = {
      ...records,
      initialView: { latitude: 37.65, longitude: 138, zoom: 6 },
      isCluster: true,
      page: "map-anather",
      shapes: [],
    };

    expect(readMapBootstrap()).toMatchObject({ page: "map-anather", isCluster: true });
  });

  it.each(["temporary-map", "temporary-map-mobile"] as const)(
    "reads %s bootstrap data",
    (page) => {
      window.__GEOCODE_MAP_BOOTSTRAP__ = {
        ...records,
        initialView: { latitude: 35, longitude: 139, zoom: 8 },
        isChecked: true,
        isMapUiHidden: false,
        isMaster: false,
        page,
        shapes: {},
      };

      expect(readMapBootstrap().page).toBe(page);
    },
  );

  it("rejects page-specific data with the wrong shape", () => {
    window.__GEOCODE_MAP_BOOTSTRAP__ = {
      ...records,
      initialView: { latitude: 37.65, longitude: 138, zoom: 6 },
      isCluster: "yes",
      page: "map-anather",
      shapes: [],
    };

    expect(() => readMapBootstrap()).toThrow("Another-map bootstrap data is invalid");
  });

  it("rejects another-window bootstrap data without an initial view", () => {
    window.__GEOCODE_MAP_BOOTSTRAP__ = {
      ...records,
      isCluster: true,
      page: "map-anather",
      shapes: [],
    };

    expect(() => readMapBootstrap()).toThrow("Another-map bootstrap data is invalid");
  });

  it("restores full JSON data and reads it only once before releasing the source DOM", () => {
    const text = '漢字𠮷🙂e\u0301\n"quoted"\\path\u2028\u2029</script>&<b>全文</b>';
    const data = {
      ...answerData(),
      tileVisibilityAccountId: "account",
      tileOverlays: [],
      layers: { layer: { id: "layer", layer_name: text } },
      markers: { marker: { id: "marker", detail: text } },
      shapes: [{ id: "shape", geojson: { properties: { memo: text } } }],
      popupBodies: {
        "marker:marker": { free_text: text, managed_markdown: `**${text}**`, sync_required: false },
        "shape:shape": { free_text: "", managed_markdown: text, sync_required: true },
      },
      answerPreview: {
        ...answerData().answerPreview,
        targetCount: 2,
        targets: ["marker:marker", "shape:shape"],
        initialView: { latitude: 34.69, longitude: 135.5, zoom: 12 },
      },
    };
    const script = jsonBlock(data);
    const raw = script.textContent;
    const parse = vi.spyOn(JSON, "parse");
    const first = readMapBootstrap();
    expect(first).toEqual(data);
    expect(window.__GEOCODE_MAP_BOOTSTRAP__).toBe(first);
    expect(readMapBootstrap()).toBe(first);
    expect(parse.mock.calls.filter(([input]) => input === raw)).toHaveLength(1);
    expect(document.getElementById("geocode-map-bootstrap")).toBeNull();
    expect(script.isConnected).toBe(false);
    expect(document.body.textContent).not.toContain(text);
  });

  it("keeps __proto__ as an own JSON property without changing prototypes", () => {
    const raw = JSON.stringify(answerData())
      .replace('"markers":{}', '"markers":{"__proto__":{"polluted":"marker-data"}}')
      .replace('{"layers"', '{"__proto__":{"polluted":"root-data"},"layers"');
    jsonBlock(raw, true);
    const value = readMapBootstrap() as unknown as Record<string, unknown>;
    const markers = value.markers as Record<string, unknown>;
    expect(Object.hasOwn(value, "__proto__")).toBe(true);
    expect(value.__proto__).toEqual({ polluted: "root-data" });
    expect(Object.hasOwn(markers, "__proto__")).toBe(true);
    expect(markers.__proto__).toEqual({ polluted: "marker-data" });
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(markers)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("restores only referenced fields before caching, preserving full text, user data and order", () => {
    const transport = referencedData();
    const expected = JSON.parse(JSON.stringify(transport));
    expected.markers.same.detail = transport.popupBodies["marker:same"].free_text + transport.popupBodies["marker:same"].managed_markdown;
    expected.shapes[0].geojson.properties.memo = transport.popupBodies["shape:same"].managed_markdown;
    delete expected.normalBodyReferences;
    const node = jsonBlock(transport);
    const raw = node.textContent;
    const parse = vi.spyOn(JSON, "parse");
    const first = readMapBootstrap();
    expect(first).toEqual(expected);
    expect(first).not.toHaveProperty("normalBodyReferences");
    expect(readMapBootstrap()).toBe(first);
    expect(window.__GEOCODE_MAP_BOOTSTRAP__).toBe(first);
    expect(parse.mock.calls.filter(([input]) => input === raw)).toHaveLength(1);
    expect(node.isConnected).toBe(false);
    expect(transport.markers.same).not.toHaveProperty("detail");
  });

  it.each([
    ["", "", false], ["", "回答", true], ["自由", "", false],
    ["e\u0301", "\u00e9🙂\r\n", true],
  ] as const)("restores exact empty/Unicode leaves (%j, %j)", (free, managed, sync) => {
    const data = referencedData();
    data.popupBodies["marker:same"] = { free_text: free, managed_markdown: managed, sync_required: sync };
    jsonBlock(data);
    const result = readMapBootstrap() as any;
    expect(result.markers.same.detail).toBe(free + managed);
    expect(result.popupBodies["marker:same"].sync_required).toBe(sync);
  });

  it("keeps literal reference-looking text and GeoJSON properties without a root sidecar", () => {
    const data = referencedData();
    delete data.normalBodyReferences;
    data.markers.same.detail = '{"normalBodyReferences":{"version":1}}';
    data.shapes[0].geojson.properties.memo = { normalBodyReferences: "unchanged legacy value" };
    jsonBlock(data);
    expect(readMapBootstrap()).toEqual(data);
  });

  it.each([
    ["null sidecar", (v: any) => { v.normalBodyReferences = null; }],
    ["array sidecar", (v: any) => { v.normalBodyReferences = []; }],
    ["unknown version", (v: any) => { v.normalBodyReferences.version = 2; }],
    ["string version", (v: any) => { v.normalBodyReferences.version = "1"; }],
    ["missing version", (v: any) => { delete v.normalBodyReferences.version; }],
    ["missing marker array", (v: any) => { delete v.normalBodyReferences.markers; }],
    ["missing shape array", (v: any) => { delete v.normalBodyReferences.shapes; }],
    ["unknown sidecar key", (v: any) => { v.normalBodyReferences.extra = false; }],
    ["nonarray IDs", (v: any) => { v.normalBodyReferences.markers = {}; }],
    ["number ID", (v: any) => { v.normalBodyReferences.markers = [1]; }],
    ["empty ID", (v: any) => { v.normalBodyReferences.markers = [""]; }],
    ["oversized ID", (v: any) => { v.normalBodyReferences.markers = ["a".repeat(129)]; }],
    ["kind-prefixed ID", (v: any) => { v.normalBodyReferences.markers = ["shape:same"]; }],
    ["duplicate marker ID", (v: any) => { v.normalBodyReferences.markers.push("same"); }],
    ["duplicate shape ID", (v: any) => { v.normalBodyReferences.shapes.push("same"); }],
    ["unknown marker", (v: any) => { v.normalBodyReferences.markers = ["missing"]; }],
    ["unknown shape", (v: any) => { v.normalBodyReferences.shapes = ["missing"]; }],
    ["wrong kind", (v: any) => { v.normalBodyReferences.markers = ["fallback"]; }],
    ["marker own ID mismatch", (v: any) => { v.markers.same.id = "other"; }],
    ["marker numeric ID", (v: any) => { v.markers.same.id = 1; }],
    ["missing marker ID", (v: any) => { delete v.markers.same.id; }],
    ["missing shape ID", (v: any) => { delete v.shapes[0].id; }],
    ["ambiguous shape IDs", (v: any) => { v.shapes.push({ ...v.shapes[0] }); }],
    ["existing detail", (v: any) => { v.markers.same.detail = ""; }],
    ["existing memo", (v: any) => { v.shapes[0].geojson.properties.memo = null; }],
    ["missing properties", (v: any) => { delete v.shapes[0].geojson.properties; }],
    ["nonobject GeoJSON", (v: any) => { v.shapes[0].geojson = []; }],
    ["missing popup", (v: any) => { delete v.popupBodies["shape:same"]; }],
    ["wrong popup kind", (v: any) => { v.popupBodies["shape:same"] = undefined; }],
    ["invalid free leaf", (v: any) => { v.popupBodies["marker:same"].free_text = null; }],
    ["invalid managed leaf", (v: any) => { v.popupBodies["shape:same"].managed_markdown = {}; }],
    ["invalid sync flag", (v: any) => { v.popupBodies["shape:same"].sync_required = "false"; }],
  ] as const)("rejects body references without publishing or removing source: %s", (_, alter) => {
    const data = referencedData();
    alter(data);
    const node = jsonBlock(data);
    expect(() => readMapBootstrap()).toThrow(/^Answer-map body references are invalid$/);
    expect(window.__GEOCODE_MAP_BOOTSTRAP__).toBeUndefined();
    expect(node.isConnected).toBe(true);
  });

  it("validates all references before changing even the private parse result", () => {
    const data = referencedData();
    data.normalBodyReferences.shapes.push("missing");
    expect(() => restoreNormalBodyReferences(data)).toThrow();
    expect(data.markers.same).not.toHaveProperty("detail");
    expect(data.shapes[0].geojson.properties).not.toHaveProperty("memo");
    expect(data).toHaveProperty("normalBodyReferences");
  });

  it.each(["target", "ID", "popup entry", "popup leaf", "properties", "existing inherited field"])(
    "requires own data and absent destination fields: %s", (part) => {
      const data = referencedData();
      if (part === "target") data.markers = Object.create(data.markers);
      if (part === "ID") { data.markers.same = Object.create(data.markers.same); }
      if (part === "popup entry") data.popupBodies = Object.create(data.popupBodies);
      if (part === "popup leaf") data.popupBodies["marker:same"] = Object.create(data.popupBodies["marker:same"]);
      if (part === "properties") data.shapes[0].geojson = Object.create(data.shapes[0].geojson);
      if (part === "existing inherited field") Object.setPrototypeOf(data.markers.same, { detail: "old" });
      expect(() => restoreNormalBodyReferences(data)).toThrow(/^Answer-map body references are invalid$/);
      expect(Object.hasOwn(data.markers.same, "detail")).toBe(false);
    },
  );

  it("does not publish a restored value if the ordinary bootstrap validation fails", () => {
    const data = referencedData();
    data.tileServers = null;
    const node = jsonBlock(data);
    expect(() => readMapBootstrap()).toThrow(/^Map bootstrap data is invalid$/);
    expect(window.__GEOCODE_MAP_BOOTSTRAP__).toBeUndefined();
    expect(node.isConnected).toBe(true);
  });

  it("rejects encoded existing globals without mutation or JSON fallback", () => {
    const data = referencedData();
    window.__GEOCODE_MAP_BOOTSTRAP__ = data;
    const node = jsonBlock(answerData());
    expect(() => readMapBootstrap()).toThrow(/^Answer-map body references are invalid$/);
    expect(window.__GEOCODE_MAP_BOOTSTRAP__).toBe(data);
    expect(data.markers.same).not.toHaveProperty("detail");
    expect(data).toHaveProperty("normalBodyReferences");
    expect(node.isConnected).toBe(true);
  });

  it("preserves a valid legacy global without parsing a JSON block", () => {
    const legacy = answerData();
    window.__GEOCODE_MAP_BOOTSTRAP__ = legacy;
    const script = jsonBlock("not JSON", true);
    const parse = vi.spyOn(JSON, "parse");
    expect(readMapBootstrap()).toBe(legacy);
    expect(parse).not.toHaveBeenCalled();
    expect(script.isConnected).toBe(true);
  });

  it.each([null, false, [], { page: "invalid" }])(
    "does not replace an invalid existing global (%j) with JSON data",
    (legacy) => {
      window.__GEOCODE_MAP_BOOTSTRAP__ = legacy;
      const script = jsonBlock(answerData());
      expect(() => readMapBootstrap()).toThrow();
      expect(window.__GEOCODE_MAP_BOOTSTRAP__).toBe(legacy);
      expect(script.isConnected).toBe(true);
    },
  );

  it.each([
    ['{"private":"秘密本文",', /^Map bootstrap data is invalid$/],
    ["null", /^Answer-map bootstrap data is invalid$/],
    ["[]", /^Answer-map bootstrap data is invalid$/],
    ['"private text"', /^Answer-map bootstrap data is invalid$/],
  ] as const)(
    "rejects invalid JSON/records without caching partial data (%s)",
    (raw, message) => {
      const script = jsonBlock(raw, true);
      expect(() => readMapBootstrap()).toThrow(message);
      expect(window.__GEOCODE_MAP_BOOTSTRAP__).toBeUndefined();
      expect(script.isConnected).toBe(true);
      expect(() => readMapBootstrap()).toThrow();
    },
  );

  it.each([
    { layers: null },
    { markers: [] },
    { initialView: undefined },
    { shapes: {} },
    { isCluster: "true" },
    { answerPreview: false },
    { answerPreview: { query: [], targets: [] } },
    { answerPreview: { query: {}, targets: null } },
    { page: "map-anather" },
    { page: "temporary-map" },
    { page: "map" },
  ])("does not cache or remove invalid answer-map data (%j)", (invalid) => {
    const script = jsonBlock({ ...answerData(), ...invalid });
    expect(() => readMapBootstrap()).toThrow();
    expect(window.__GEOCODE_MAP_BOOTSTRAP__).toBeUndefined();
    expect(script.isConnected).toBe(true);
  });

  it.each(["div", "text/javascript", "application/json; charset=utf-8"])(
    "rejects a bootstrap node with the wrong element/type (%s)",
    (kind) => {
      const element = kind === "div" ? document.createElement("div") : document.createElement("script");
      element.id = "geocode-map-bootstrap";
      // Append inertly; changing type afterward lets us check rejection without
      // asking jsdom to execute the intentionally wrong JavaScript script type.
      if (element instanceof HTMLScriptElement) element.type = "application/json";
      element.textContent = JSON.stringify(answerData());
      document.body.append(element);
      if (element instanceof HTMLScriptElement) element.type = kind;
      expect(() => readMapBootstrap()).toThrow();
      expect(window.__GEOCODE_MAP_BOOTSTRAP__).toBeUndefined();
      expect(element.isConnected).toBe(true);
    },
  );
});
