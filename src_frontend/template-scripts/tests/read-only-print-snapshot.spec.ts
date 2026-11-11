import { describe, expect, it } from "vitest";
import type { PrintMapState } from "../src/map/common/print-state";
import { MAX_SHARE_BYTES, MAX_SHARE_OBJECTS } from "../src/map/common/share-snapshot";
import {
  createReadOnlyPrintSnapshot,
  isReadOnlyPrintSnapshot,
  type ReadOnlyPrintSource,
} from "../src/map/print/read-only-print-snapshot";

function fixture() {
  const layer = {
    id: "a",
    layer_name: "表示中",
    user_id: "owner",
    is_master: false,
  };
  const marker = (id: string, layer_id = "a") => ({
    id,
    layer_id,
    marker_name: id,
    detail: `${id} の本文`,
    latitude: 35,
    longitude: 139,
  });
  const source = {
    sourcePage: "temporary-map",
    layers: {
      a: { ...layer, ownerReference: "private-layer-reference" },
      b: { ...layer, id: "b", layer_name: "non-selected-layer" },
    },
    markers: {
      visible: { ...marker("visible"), bodyUrl: "private-body-url" },
      filtered: marker("filtered"),
      offLayer: marker("offLayer", "b"),
    },
    shapes: [
      {
        id: "line",
        layer_id: "a",
        name: "表示中の図形",
        user_id: "owner",
        shape_type: "polyline",
        geojson: {
          type: "Feature",
          geometry: {
            type: "LineString",
            coordinates: [
              [139, 35],
              [140, 36],
            ],
          },
          properties: {
            memo: "図形メモ",
            style: { color: "#123456", weight: 2, privateStyle: "private-style" },
            ownerReference: "private-shape-reference",
          },
        },
      },
    ],
    tileServers: {
      "1": {
        id: 1,
        layer_name: "base",
        label: "背景地図",
        url: "/tile/{z}/{x}/{y}.png",
        attribution: "test",
        include_foreign_tiles: true,
        min_zoom: null,
        max_zoom: 22,
        authToken: "private-base-token",
      },
    },
    tileOverlays: [
      {
        id: "overlay",
        name: "重ね合わせ",
        url: "https://tiles.example.test/{z}/{x}/{y}.png",
        attribution: "test",
        min_zoom: 0,
        max_zoom: 22,
        opacity: 1,
        sort_order: 0,
        ownerReference: "private-overlay-reference",
      },
    ],
  } satisfies ReadOnlyPrintSource & {
    layers: Record<string, ReadOnlyPrintSource["layers"][string] & { ownerReference?: string }>;
    markers: Record<string, ReadOnlyPrintSource["markers"][string] & { bodyUrl?: string }>;
    tileServers: Record<
      string,
      ReadOnlyPrintSource["tileServers"][string] & { authToken?: string }
    >;
    tileOverlays: (ReadOnlyPrintSource["tileOverlays"][number] & { ownerReference?: string })[];
  };
  const state: PrintMapState = {
    view: { latitude: 35, longitude: 139, zoom: 10 },
    tileServerId: "1",
    overlays: { overlay: false },
    layerIds: ["a"],
    markersVisible: true,
    shapesVisible: true,
    shapeNamesVisible: true,
    markerIds: ["visible", "filtered", "offLayer"],
    shapeIds: ["line"],
    coloring: {
      version: 1,
      rules: [
        { id: "visible-rule", label: "表示中の分類", color: "#123456" },
        { id: "filtered-rule", label: "filtered-rule-label", color: "#345678" },
      ],
      targets: { "marker:visible": "visible-rule", "marker:filtered": "filtered-rule" },
    },
  };
  return { source, state, keys: new Set(["marker:visible", "shape:line", "marker:offLayer"]) };
}

describe("read-only print snapshot", () => {
  it("旧共有から表示対象のレコードと描画設定だけを固定する", () => {
    const { source, state, keys } = fixture();
    const snapshot = createReadOnlyPrintSnapshot(
      {
        ...source,
        ...{ shareUrl: "/onetime/private-share-url", geocoderShareToken: "private-token" },
      },
      { ...state, ...{ ownerAccountId: "private-account-id" } },
      keys,
    );
    expect(snapshot.sourcePage).toBe("temporary-map");
    expect(snapshot.layers.a).toMatchObject({ marker_icon_id: null, marker_icon_filename: null });
    expect(snapshot.state).toMatchObject({
      view: state.view,
      overlays: { overlay: false },
      layerIds: ["a"],
      markerIds: ["visible"],
      shapeIds: ["line"],
      coloring: {
        rules: [state.coloring!.rules[0]],
        targets: { "marker:visible": "visible-rule" },
      },
    });
    expect(snapshot.shapes[0].geojson.properties).toEqual({
      memo: "図形メモ",
      style: { color: "#123456", weight: 2 },
    });
    expect(JSON.stringify(snapshot)).not.toMatch(/filtered|offLayer|non-selected-layer|private-/);
    source.markers.visible.detail = "更新後の本文";
    source.shapes[0].geojson.geometry.coordinates[0][0] = 0;
    state.view.latitude = 0;
    expect(snapshot.markers.visible.detail).toBe("visible の本文");
    expect(snapshot.shapes[0].geojson.geometry).toMatchObject({
      coordinates: [
        [139, 35],
        [140, 36],
      ],
    });
    expect(snapshot.state.view.latitude).toBe(35);
    expect(isReadOnlyPrintSnapshot(snapshot)).toBe(true);
  });

  it("スナップショット共有の区別を保持し、背景地図のみでも受け付ける", () => {
    const { source, state } = fixture();
    const snapshot = createReadOnlyPrintSnapshot(
      { ...source, snapshotShare: true },
      { ...state, layerIds: [], clusteringMinZoom: 12 },
      new Set(),
    );
    expect(snapshot.snapshotShare).toBe(true);
    expect(snapshot.state.clusteringMinZoom).toBe(12);
    expect(snapshot.layers).toEqual({});
    expect(snapshot.markers).toEqual({});
    expect(snapshot.shapes).toEqual([]);
    expect(snapshot.state.markerIds).toEqual([]);
    expect(snapshot.state.shapeIds).toEqual([]);
    expect(snapshot.state.coloring).toBeUndefined();
    expect(snapshot.tileServers["1"].url).toBe("/tile/{z}/{x}/{y}.png");
    expect(isReadOnlyPrintSnapshot(snapshot)).toBe(true);
    expect(isReadOnlyPrintSnapshot({ ...snapshot, sourcePage: "map-anather" })).toBe(false);
    expect(
      isReadOnlyPrintSnapshot({ ...snapshot, sourcePage: "map-anather", snapshotShare: false }),
    ).toBe(true);
  });

  it("転送データで対象ID・所属・色割当と描画定義の不整合を拒否する", () => {
    const { source, state, keys } = fixture();
    const snapshot = createReadOnlyPrintSnapshot(source, state, keys);
    const withState = (patch: Partial<PrintMapState>) => ({
      ...snapshot,
      state: { ...snapshot.state, ...patch },
    });
    expect(isReadOnlyPrintSnapshot(withState({ markerIds: [] }))).toBe(false);
    expect(isReadOnlyPrintSnapshot(withState({ markerIds: new Array(1) }))).toBe(false);
    expect(isReadOnlyPrintSnapshot(withState({ shapeIds: ["line", "other"] }))).toBe(false);
    expect(isReadOnlyPrintSnapshot(withState({ layerIds: null }))).toBe(false);
    expect(isReadOnlyPrintSnapshot(withState({ coloring: state.coloring }))).toBe(false);
    expect(isReadOnlyPrintSnapshot(withState({ tileServerId: "9" }))).toBe(false);
    expect(isReadOnlyPrintSnapshot(withState({ overlays: { foreign: true } }))).toBe(false);
    expect(isReadOnlyPrintSnapshot({ ...snapshot, geocoderShareToken: "private" })).toBe(false);
    expect(
      isReadOnlyPrintSnapshot({
        ...snapshot,
        markers: { visible: { ...snapshot.markers.visible, layer_id: "b" } },
      }),
    ).toBe(false);
    expect(
      isReadOnlyPrintSnapshot({
        ...snapshot,
        markers: { visible: { ...snapshot.markers.visible, normalBodyReferences: {} } },
      }),
    ).toBe(false);
    expect(
      isReadOnlyPrintSnapshot({
        ...snapshot,
        shapes: [snapshot.shapes[0], snapshot.shapes[0]],
        state: { ...snapshot.state, shapeIds: ["line", "other"] },
      }),
    ).toBe(false);
    expect(
      isReadOnlyPrintSnapshot({
        ...snapshot,
        tileServers: { "1": { ...snapshot.tileServers["1"], url: "javascript:alert(1)" } },
      }),
    ).toBe(false);
  });

  it("1万件を超えるデータを切り詰めず拒否する", () => {
    const { source, state } = fixture();
    const markers = Object.fromEntries(
      Array.from({ length: MAX_SHARE_OBJECTS + 1 }, (_, i) => [
        `m${i}`,
        { ...source.markers.visible, id: `m${i}` },
      ]),
    );
    const keys = new Set(Object.keys(markers).map((id) => `marker:${id}`));
    expect(() => createReadOnlyPrintSnapshot({ ...source, markers }, state, keys)).toThrow(
      "10,000件超",
    );
  });

  it("UTF-8換算で32MiBを超えるデータを拒否する", () => {
    const { source, state, keys } = fixture();
    source.markers.visible.detail = "界".repeat(Math.ceil(MAX_SHARE_BYTES / 3));
    expect(() => createReadOnlyPrintSnapshot(source, state, keys)).toThrow("32MiB超");
  });

  it("v1のラスタ既定値を旧projectionへ戻し、v2ではベクタ定義を保持する", () => {
    const { source, state, keys } = fixture();
    const raster = {
      ...source,
      tileServers: {
        "1": { ...source.tileServers["1"], kind: "raster" as const, style_url: null },
      },
    };
    const legacy = createReadOnlyPrintSnapshot(raster, state, keys);
    expect(legacy.version).toBe(1);
    expect(legacy.tileServers["1"]).not.toHaveProperty("kind");
    expect(legacy.tileServers["1"]).not.toHaveProperty("style_url");
    const vector = {
      ...raster,
      tileServers: {
        ...raster.tileServers,
        "2": {
          ...source.tileServers["1"],
          id: 2,
          kind: "vector" as const,
          style_url: "https://styles.example.test/style.json",
        },
      },
    };
    const before = JSON.stringify(vector);
    const snapshot = createReadOnlyPrintSnapshot(vector, state, keys);
    expect(snapshot.version).toBe(2);
    expect(snapshot.tileServers["2"]).toMatchObject({
      kind: "vector",
      style_url: "https://styles.example.test/style.json",
    });
    expect(snapshot.tileServers["2"]).not.toHaveProperty("authToken");
    expect(isReadOnlyPrintSnapshot(JSON.parse(JSON.stringify(snapshot)))).toBe(true);
    expect(JSON.stringify(vector)).toBe(before);
    expect(isReadOnlyPrintSnapshot({ ...snapshot, version: 1 })).toBe(false);
    expect(
      isReadOnlyPrintSnapshot({
        ...snapshot,
        tileServers: {
          ...snapshot.tileServers,
          "2": { ...snapshot.tileServers["2"], kind: "unknown" },
        },
      }),
    ).toBe(false);
    expect(
      isReadOnlyPrintSnapshot({
        ...snapshot,
        tileServers: {
          ...snapshot.tileServers,
          "2": { ...snapshot.tileServers["2"], style_url: "//untrusted.test/style.json" },
        },
      }),
    ).toBe(false);
    expect(
      isReadOnlyPrintSnapshot({
        ...snapshot,
        tileServers: { ...snapshot.tileServers, "1": { ...snapshot.tileServers["2"], id: 1 } },
      }),
    ).toBe(false);
  });

  it("読取済みv2は全背景がラスタでも印刷snapshotでversionを維持する", () => {
    const { source, state, keys } = fixture();
    const snapshot = createReadOnlyPrintSnapshot({ ...source, version: 2 }, state, keys);
    expect(snapshot.version).toBe(2);
    expect(snapshot.tileServers["1"]).toMatchObject({ kind: "raster", style_url: null });
    expect(isReadOnlyPrintSnapshot(snapshot)).toBe(true);
    const roundTrip = createReadOnlyPrintSnapshot(snapshot, snapshot.state, keys);
    expect(roundTrip).toEqual(snapshot);
  });
});
