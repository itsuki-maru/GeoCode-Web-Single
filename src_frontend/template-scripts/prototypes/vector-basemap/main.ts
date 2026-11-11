import { createPrintPreview, createReadOnlySnapshotPrintPreview } from "../../src/map/print/print-preview";
import { prepareMaplibreCanvasPrint } from "../../src/map/print/canvas-snapshot";
import { createShareMapSnapshot, isStoredShareMapSnapshot } from "../../src/map/common/share-snapshot";
import { createReadOnlyPrintSnapshot, isReadOnlyPrintSnapshot } from "../../src/map/print/read-only-print-snapshot";
import type { AnotherMapBootstrap } from "../../src/map/types";
import type { PrintMapState } from "../../src/map/common/print-state";
import { createPrototypeVectorBasemap } from "./maplibre-basemap";

const L = (window as any).L;
const savedStorage = JSON.stringify({ ...localStorage });
const violations: string[] = [];
window.addEventListener("securitypolicyviolation", (event) => violations.push(event.violatedDirective));
const state: PrintMapState = {
  view: { latitude: 35.68, longitude: 139.76, zoom: 14 },
  tileServerId: "1", overlays: {}, markersVisible: true, shapesVisible: true,
  shapeNamesVisible: true, layerIds: [],
};
const bootstrap: AnotherMapBootstrap = {
  page: "map-anather", isCluster: false, initialView: state.view,
  tileServers: { "1": {
    id: 1, url: "/fixtures/raster/{z}/{x}/{y}.png", attribution: "GeoCode-Web 自作検証データ",
    label: "既存ラスタ", layer_name: "既存ラスタ", include_foreign_tiles: true, min_zoom: 0, max_zoom: 18,
  } },
  tileOverlays: [], layers: {}, markers: {}, shapes: [],
};
const snapshot = createShareMapSnapshot(bootstrap as any, state, new Set());
const printSnapshot = createReadOnlyPrintSnapshot({ ...bootstrap, tileOverlays: [], sourcePage: "map-anather" }, state, new Set());
// 通常の印刷入口と、保存済みv1共有地図の印刷経路の両方を検証する。
const legacyShare = new URLSearchParams(location.search).has("legacy-share");
const preview = legacyShare
  ? createReadOnlySnapshotPrintPreview(
      { ...printSnapshot, sourcePage: "temporary-map", snapshotShare: true },
      () => {}, { parentOrigin: location.origin, requestId: "prototype-legacy-share" },
    )
  : createPrintPreview(state, () => {}, "map-anather", undefined, undefined, bootstrap);
const mobileStyle = document.createElement("style");
mobileStyle.textContent = `@media screen and (max-width:600px) {
  #print-layout { grid-template-columns:minmax(0,1fr); grid-template-rows:48vh minmax(0,1fr); }
  #print-settings { padding:12px; border-right:0; border-bottom:1px solid #bbcbd9; }
}`;
document.head.append(mobileStyle);
const map = preview.map as any;
const raster = Object.values(map._layers).find((layer) => layer instanceof L.TileLayer) as any;
const marker = L.marker([35.676, 139.765], { icon: L.divIcon({ className: "prototype-marker" }) })
  .bindTooltip("既存Leafletマーカー", { permanent: true }).addTo(map);
L.polygon([[35.675, 139.749], [35.678, 139.751], [35.674, 139.756]], {
  color: "#b62835", weight: 3, fillOpacity: 0.18,
}).addTo(map);
const controls = document.createElement("section");
controls.id = "prototype-controls";
controls.innerHTML = `<strong>背景地図の試作</strong><p>通常画面・DB・共有URLの形式は変更しません。</p>
  <button id="prototype-vector" type="button">ベクタ背景</button>
  <button id="prototype-raster" type="button">ラスタ背景</button>
  <button id="prototype-failure" type="button">取得失敗を確認</button>
  <p id="prototype-status" role="status">ラスタ背景を表示中</p>`;
document.getElementById("print-settings")!.prepend(controls);
document.getElementById("print-title-input")!.setAttribute("value", "東京・ベクタ背景の検証");
document.getElementById("print-title-input")!.dispatchEvent(new Event("input", { bubbles: true }));
const status = document.getElementById("prototype-status")!;
let generation = 0;
let active: ReturnType<typeof createPrototypeVectorBasemap> | undefined;
let candidate: ReturnType<typeof createPrototypeVectorBasemap> | undefined;
let selected = "raster";
let pending = false;
let restorePrint: (() => void) | undefined;
const settle = () => map.fire("layeradd", { layer: active?.layer ?? raster });

async function selectVector(style = "/fixtures/style.json", timeout = 30000): Promise<boolean> {
  const ownGeneration = ++generation;
  if (candidate) map.removeLayer(candidate.layer);
  const next = createPrototypeVectorBasemap(style, timeout);
  candidate = next;
  pending = true;
  status.textContent = "ベクタ背景を読み込み中…";
  try {
    next.layer.addTo(map);
    next.layer.getContainer().style.opacity = "0";
    await next.ready;
    if (ownGeneration !== generation) return false;
    if (active) map.removeLayer(active.layer);
    map.removeLayer(raster);
    next.layer.getContainer().style.opacity = "1";
    active = next;
    selected = "vector";
    status.textContent = "ベクタ背景を表示中（MVT・日本語文字・アイコン）";
    return true;
  } catch {
    map.removeLayer(next.layer);
    if (ownGeneration === generation) status.textContent = "取得に失敗したため、直前の背景を維持しました。";
    return false;
  } finally {
    if (ownGeneration === generation) {
      candidate = undefined;
      pending = false;
      settle();
    }
  }
}
function selectRaster() {
  ++generation;
  if (candidate) map.removeLayer(candidate.layer);
  candidate = undefined;
  if (active) map.removeLayer(active.layer);
  active = undefined;
  raster.addTo(map);
  selected = "raster";
  pending = false;
  status.textContent = "ラスタ背景を表示中";
  settle();
}
controls.querySelector("#prototype-vector")!.addEventListener("click", () => void selectVector());
controls.querySelector("#prototype-raster")!.addEventListener("click", selectRaster);
controls.querySelector("#prototype-failure")!.addEventListener("click", () => void selectVector("/fixtures/missing-style.json", 5000));

const snapshotBytes = JSON.stringify(snapshot);
const compatibility = () => ({
  v1: snapshot.version === 1 && isStoredShareMapSnapshot(snapshot),
  printV1: isReadOnlyPrintSnapshot(printSnapshot),
  unchangedSnapshot: JSON.stringify(snapshot) === snapshotBytes,
  unchangedStorage: JSON.stringify({ ...localStorage }) === savedStorage,
  sharedLeaflet: active ? active.layer instanceof L.Layer : true,
});
(window as any).prototype = {
  map, marker, selectVector, selectRaster, compatibility,
  getState: () => ({ selected, pending, print: active?.layer.getPrintStatus(), violations }),
  getFeatures: () => active?.getMap()?.queryRenderedFeatures().map((feature) => ({
    layer: feature.layer.id, properties: feature.properties,
  })) ?? [],
  preparePrint: async () => {
    if (pending || active?.layer.getPrintStatus().loading || active?.layer.getPrintStatus().failed)
      throw new Error("背景の描画が完了していません。");
    restorePrint = await prepareMaplibreCanvasPrint(document.getElementById("map")!, new AbortController().signal);
  },
  restorePrint: () => { restorePrint?.(); restorePrint = undefined; },
  dispose: () => { selectRaster(); preview.dispose(); },
};
