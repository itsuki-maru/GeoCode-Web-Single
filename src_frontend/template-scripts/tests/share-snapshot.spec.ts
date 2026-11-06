import { describe, expect, it } from "vitest";
import {
  createShareMapSnapshot,
  isShareMapSnapshot,
  type ShareMapSnapshot,
  resolveShareParentOrigin,
} from "../src/map/common/share-snapshot";

function fixture(): ShareMapSnapshot {
  const layer = {
    id: "a",
    layer_name: "A",
    user_id: "owner",
    is_master: false,
    marker_icon_filename: null,
    marker_icon_id: null,
  };
  const marker = (id: string) => ({
    id,
    layer_id: "a",
    marker_name: id,
    detail: `${id} body`,
    latitude: 35,
    longitude: 139,
  });
  return {
    version: 1,
    layers: { a: layer, b: { ...layer, id: "b" } },
    markers: { keep: marker("keep"), excluded: marker("excluded") },
    shapes: [],
    tileServers: {
      "1": {
        id: 1,
        layer_name: "base",
        label: "base",
        url: "https://example.test/{z}/{x}/{y}",
        attribution: "test",
        include_foreign_tiles: true,
        min_zoom: 0,
        max_zoom: 22,
      },
    },
    tileOverlays: [],
    state: {
      view: { latitude: 35, longitude: 139, zoom: 10 },
      tileServerId: "1",
      overlays: {},
      layerIds: ["a"],
      markersVisible: true,
      shapesVisible: true,
      shapeNamesVisible: false,
      markerIds: ["keep", "excluded"],
      shapeIds: [],
      coloring: {
        version: 1,
        rules: [{ id: "r", label: "分類", color: "#123456" }],
        targets: { "marker:keep": "r", "marker:excluded": "r" },
      },
    },
  };
}

describe("share snapshot data boundary", () => {
  it("共有内容の送信先は同一originかサーバーが許可した開発originに限定する", () => {
    const own = "https://map.example.test";
    const dev = "http://localhost:5173";
    expect(resolveShareParentOrigin(`${own}/index`, own)).toBe(own);
    expect(resolveShareParentOrigin("", own)).toBe(own);
    expect(resolveShareParentOrigin(`${dev}/index`, own)).toBeNull();
    expect(resolveShareParentOrigin(`${dev}/index`, own, [dev])).toBe(dev);
    expect(
      resolveShareParentOrigin("https://attacker.test/?parent_origin=" + dev, own, [dev]),
    ).toBeNull();
    expect(resolveShareParentOrigin("http://localhost:51730", own, [dev])).toBeNull();
  });
  it("除外対象を本文・ID・色分けから除去し、元データ変更から独立させる", () => {
    const data = fixture();
    const captured = createShareMapSnapshot(data, data.state, new Set(["marker:keep"]));
    expect(Object.keys(captured.layers)).toEqual(["a"]);
    expect(Object.keys(captured.markers)).toEqual(["keep"]);
    expect(captured.state.markerIds).toEqual(["keep"]);
    expect(captured.state.coloring?.targets).toEqual({ "marker:keep": "r" });
    expect(JSON.stringify(captured)).not.toContain("excluded");
    data.markers.keep!.detail = "changed";
    data.state.view.latitude = 0;
    expect(captured.markers.keep!.detail).toBe("keep body");
    expect(captured.state.view.latitude).toBe(35);
    expect(isShareMapSnapshot(captured)).toBe(true);
  });
  it("解除状態を保存し、クラスタ解除下限は共有データに含めない", () => {
    const data = fixture();
    const state = { ...data.state, clusteringEnabled: false, clusteringMinZoom: 10 };
    const captured = createShareMapSnapshot(data, state, new Set(["marker:keep"]));
    expect(captured.state.clusteringEnabled).toBe(false);
    expect(captured.state).not.toHaveProperty("clusteringMinZoom");
  });
  it("0件やグループ未選択を全件扱いにしない", () => {
    const data = fixture();
    const captured = createShareMapSnapshot(data, { ...data.state, layerIds: [] }, new Set());
    expect(captured.layers).toEqual({});
    expect(captured.markers).toEqual({});
    expect(captured.state.markerIds).toEqual([]);
    expect(captured.state.coloring?.targets).toEqual({});
    expect(isShareMapSnapshot(captured)).toBe(true);
  });
  it("対象外のIDや色分類、所属グループ、未知のタイル状態を受け付けない", () => {
    const data = fixture();
    const captured = createShareMapSnapshot(data, data.state, new Set(["marker:keep"]));
    expect(
      isShareMapSnapshot({ ...captured, state: { ...captured.state, markerIds: ["excluded"] } }),
    ).toBe(false);
    expect(
      isShareMapSnapshot({
        ...captured,
        state: { ...captured.state, coloring: data.state.coloring },
      }),
    ).toBe(false);
    expect(isShareMapSnapshot({ ...captured, layers: {} })).toBe(false);
    expect(
      isShareMapSnapshot({
        ...captured,
        state: { ...captured.state, overlays: { unknown: true } },
      }),
    ).toBe(false);
    expect(isShareMapSnapshot({ ...captured, version: 2 })).toBe(false);
  });
});
