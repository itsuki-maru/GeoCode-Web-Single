import type { ShareMapSnapshot } from "../../../../../template-scripts/src/map/common/share-snapshot";

export const shareSnapshotFixture = (): ShareMapSnapshot => ({
  version: 1,
  state: {
    view: { latitude: 35.5, longitude: 139.25, zoom: 12 },
    tileServerId: "1",
    overlays: { flood: true },
    coloring: {
      version: 1,
      rules: [{ id: "rule", label: "分類A", color: "#112233" }],
      targets: { "marker:marker-a": "rule" },
    },
    objectQuery: "対象",
    markersVisible: true,
    shapesVisible: true,
    shapeNamesVisible: true,
    layerIds: ["layer-a"],
    markerIds: ["marker-a"],
    shapeIds: ["shape-a"],
  },
  layers: {
    "layer-a": {
      id: "layer-a",
      user_id: "owner",
      layer_name: "選択グループ",
      is_master: false,
      marker_icon_id: null,
      marker_icon_filename: null,
    },
  },
  markers: {
    "marker-a": {
      id: "marker-a",
      layer_id: "layer-a",
      marker_name: "対象の地点",
      detail: "保存する本文",
      latitude: 35.5,
      longitude: 139.25,
    },
  },
  shapes: [
    {
      id: "shape-a",
      layer_id: "layer-a",
      name: "対象の図形",
      user_id: "owner",
      shape_type: "circle",
      geojson: {
        type: "Feature",
        properties: { radius: 20 },
        geometry: { type: "Point", coordinates: [139.25, 35.5] },
      },
    },
  ],
  tileServers: {
    "1": {
      id: 1,
      layer_name: "standard",
      label: "標準地図",
      url: "https://example.test/{z}/{x}/{y}.png",
      attribution: "地図",
      include_foreign_tiles: false,
      min_zoom: 0,
      max_zoom: 20,
    },
  },
  tileOverlays: [
    {
      id: "flood",
      name: "浸水想定",
      url: "https://example.test/flood/{z}/{x}/{y}.png",
      attribution: "浸水",
      min_zoom: 0,
      max_zoom: 20,
      opacity: 0.5,
      sort_order: 0,
    },
  ],
});
