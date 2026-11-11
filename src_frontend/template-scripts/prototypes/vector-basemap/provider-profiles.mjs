// 明示指定した場合に使用するローカル受入検証の候補定義。DBへの自動登録は行わない。
export const PROVIDERS = Object.freeze({
  "openfreemap-liberty": Object.freeze({
    id: "openfreemap-liberty", label: "OpenFreeMap Liberty",
    styleUrl: "https://tiles.openfreemap.org/styles/liberty",
    allowedOrigins: Object.freeze(["https://tiles.openfreemap.org"]),
    attribution: '<a href="https://openfreemap.org/">OpenFreeMap</a> © <a href="https://openmaptiles.org/">OpenMapTiles</a> Data from <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    includeForeignTiles: true, minZoom: 0, maxZoom: 19,
    initialView: Object.freeze({ latitude: 35.68, longitude: 139.76, zoom: 14 }),
    docsUrl: "https://openfreemap.org/quick_start/",
    attributionTexts: Object.freeze(["OpenFreeMap", "OpenMapTiles", "OpenStreetMap"]),
  }),
  "gsi-vector-std": Object.freeze({
    id: "gsi-vector-std", label: "地理院地図Vector（標準）",
    styleUrl: "https://gsi-cyberjapan.github.io/gsivectortile-mapbox-gl-js/std.json",
    allowedOrigins: Object.freeze(["https://gsi-cyberjapan.github.io", "https://cyberjapandata.gsi.go.jp", "https://maps.gsi.go.jp"]),
    attribution: '<a href="https://maps.gsi.go.jp/vector/">国土地理院（地理院地図Vector）</a>',
    includeForeignTiles: false, minZoom: 5, maxZoom: 18,
    initialView: Object.freeze({ latitude: 35.68, longitude: 139.76, zoom: 14 }),
    docsUrl: "https://github.com/gsi-cyberjapan/gsivectortile-mapbox-gl-js",
    attributionTexts: Object.freeze(["国土地理院", "地理院地図Vector"]),
  }),
});

export function getProvider(id) {
  if (!Object.hasOwn(PROVIDERS, id)) throw new Error(`Unknown provider: ${id}`);
  return PROVIDERS[id];
}
