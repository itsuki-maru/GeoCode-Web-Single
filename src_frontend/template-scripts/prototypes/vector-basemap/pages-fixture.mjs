import { readFile, writeFile, mkdir, cp } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fixtureCenter } from "./fixtures.mjs";

export const prototypeDirectory = dirname(fileURLToPath(import.meta.url));
export const templateProject = resolve(prototypeDirectory, "../..");
export const repository = resolve(templateProject, "../..");
export const pagesOutputDirectory = resolve(repository, "target/vector-basemap-pages/site");
export const pagesEvidenceDirectory = resolve(repository, "target/vector-basemap-pages/evidence");
export const entryNames = [
  "map", "map-mobile", "map-anather", "temporary-map", "temporary-map-mobile",
  "form-answer-map", "live-map",
];

const layerId = "fixture-layer";
export const layers = {
  [layerId]: {
    id: layerId, layer_name: "Fixture objects", user_id: "fixture-user", is_master: false,
    marker_icon_id: null, marker_icon_filename: null,
  },
};
export const markers = {
  "fixture-marker": {
    id: "fixture-marker", layer_id: layerId, marker_name: "Existing Leaflet marker",
    detail: "Production page integration fixture", latitude: 35.679, longitude: 139.755,
  },
};

function tileServers(legacy = false) {
  const raster = {
    id: 1, layer_name: "fixture-raster", label: "Legacy raster", url: "/fixtures/raster/{z}/{x}/{y}.png",
    attribution: "Legacy raster fixture", min_zoom: 5, max_zoom: 18, include_foreign_tiles: false,
  };
  if (legacy) return { "1": raster };
  const vector = (id, style) => ({
    ...raster, id, layer_name: `fixture-vector-${id}`, label: `Vector ${id}`,
    kind: "vector", style_url: style, include_foreign_tiles: true,
    attribution: "Vector background fixture",
  });
  return {
    "1": raster,
    "2": vector(2, "/fixtures/style.json"),
    "3": vector(3, "/fixtures/missing-style.json"),
  };
}

// 登録地図の単独印刷検証でも共有する定義。既存ページの検証用データはそのまま使用する。
export { tileServers as fixtureTileServers };

export function printState(tileServerId = "2", view = { latitude: fixtureCenter[0], longitude: fixtureCenter[1], zoom: 14 }) {
  return {
    view: { ...view },
    tileServerId, overlays: {}, clusteringEnabled: true, clusteringAllowed: true,
    markersVisible: true, shapesVisible: true, shapeNamesVisible: true,
    layerIds: [layerId], markerIds: null, shapeIds: null,
  };
}

export function pageFixtureBootstrap(name, variant, provider) {
  const legacy = variant === "legacy";
  const records = tileServers(legacy);
  if (provider && !legacy) records["2"] = {
    ...records["2"], layer_name: provider.id, label: provider.label,
    style_url: provider.styleUrl, attribution: provider.attribution,
    min_zoom: provider.minZoom, max_zoom: provider.maxZoom,
    include_foreign_tiles: provider.includeForeignTiles,
  };
  const view = provider?.initialView ?? printState().view;
  const common = {
    page: name,
    initialView: { ...view },
    tileServers: records, tileOverlays: [], layers, markers,
    tileVisibilityAccountId: "fixture-user",
  };
  if (name === "live-map") {
    return {
      publicId: "fixture-live", cameraEnabled: false, tileServers: records,
      isCheckOverlay: true, tileOverlays: [], publishedLayers: { layers: [], markers: [], shapes: [] },
    };
  }
  if (name === "map" || name === "map-mobile") {
    return { ...common, dataSource: "server", selectedLayer: layerId, isMaster: false, markerId: "0", shapes: [] };
  }
  if (name === "map-anather" || name === "form-answer-map") {
    const result = { ...common, isCluster: true, shapes: [] };
    if (name === "form-answer-map") result.answerPreview = {
      answerCount: 1, targetCount: 1, requestId: "fixture-answer", parentOrigin: "__ORIGIN__",
      query: {}, targets: [], initialView: common.initialView,
    };
    return result;
  }
  const result = { ...common, isMaster: false, isChecked: true, isMapUiHidden: false, shapes: {} };
  if (variant === "v2") {
    result.shareSnapshot = { version: 2, state: printState("2", view), tileServers: records, tileOverlays: [] };
    // 保存済みの定義を、現在の初期データに含まれる定義より優先する。
    result.tileServers = { ...records, "2": { ...records["2"], style_url: "/fixtures/missing-style.json" } };
  }
  if (legacy) result.shareSnapshot = { version: 1, state: printState("1", view), tileServers: records, tileOverlays: [] };
  return result;
}

function fixtureScript(name, data) {
  const json = JSON.stringify(data).replaceAll("<", "\\u003c");
  return `<script>
    const fixtureBootstrap = ${json};
    if (fixtureBootstrap.answerPreview) fixtureBootstrap.answerPreview.parentOrigin = location.origin;
    window.${name === "live-map" ? "__GEOCODE_LIVE_MAP_BOOTSTRAP__" : "__GEOCODE_MAP_BOOTSTRAP__"} = fixtureBootstrap;
    var tileServers = fixtureBootstrap.tileServers;
    var layer = fixtureBootstrap.selectedLayer;
    var is_master = fixtureBootstrap.isMaster;
    var markerId = fixtureBootstrap.markerId;
    var latitude = fixtureBootstrap.initialView?.latitude;
    var longitude = fixtureBootstrap.initialView?.longitude;
    var zoom = fixtureBootstrap.initialView?.zoom;
    var layersFromAxum = fixtureBootstrap.layers;
    var markersFromAxum = fixtureBootstrap.markers;
    var shapesFromAxum = fixtureBootstrap.shapes;
    window.__pagesViolations = [];
    document.addEventListener('securitypolicyviolation', event => window.__pagesViolations.push({
      directive: event.effectiveDirective, blocked: event.blockedURI
    }));
    L.Map.addInitHook(function () { window.__pagesMap = this; });
    window.__pagesProbe = {
      map: () => window.__pagesMap,
      controller: () => window.__pagesMap?._geocodeBasemap,
      gl: () => {
        let found;
        window.__pagesMap?.eachLayer(layer => { if (layer.getMaplibreMap) found = layer.getMaplibreMap(); });
        return found;
      }
    };
  </script>`;
}

export async function buildPagesFixture({ outputDirectory = pagesOutputDirectory, evidenceDirectory = pagesEvidenceDirectory, provider } = {}) {
  const assets = resolve(outputDirectory, "assets");
  const vendor = resolve(outputDirectory, "vendor");
  await mkdir(assets, { recursive: true });
  await mkdir(vendor, { recursive: true });
  await mkdir(evidenceDirectory, { recursive: true });
  await cp(resolve(templateProject, "dist"), assets, { recursive: true });
  const vendors = [
    ["leaflet/dist/leaflet.js", "leaflet.js"],
    ["leaflet/dist/leaflet.css", "leaflet.css"],
    ["leaflet/dist/images", "images"],
    ["leaflet.markercluster/dist/leaflet.markercluster.js", "leaflet.markercluster.js"],
    ["leaflet.markercluster/dist/MarkerCluster.css", "MarkerCluster.css"],
    ["leaflet.markercluster/dist/MarkerCluster.Default.css", "MarkerCluster.Default.css"],
    ["marked/lib/marked.umd.js", "marked.min.js"],
    ["xss/dist/xss.js", "xss.min.js"],
  ];
  for (const [source, target] of vendors) {
    await cp(resolve(templateProject, "node_modules", source), resolve(vendor, target), { recursive: true });
  }
  for (const filename of ["map-controls.css", "map-compat.css", "github.css"]) {
    await cp(resolve(repository, "src_frontend/frontend/public", filename), resolve(assets, filename));
  }
  // 実際の印刷iframeが参照する/assetsにも、同じnpm管理のライブラリ資材を配信する。
  await cp(vendor, assets, { recursive: true });
  const cases = [];
  for (const name of entryNames) {
    const variants = name.startsWith("temporary-map") ? ["default", "legacy", "v2"] : ["default", "legacy"];
    for (const variant of variants) {
      let html = await readFile(resolve(repository, "src/templates", `${name}.html`), "utf8");
      html = html.replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi, (whole, attributes) => /\bsrc\s*=/.test(attributes) ? whole : "");
      html = html.replace(/{%[\s\S]*?%}/g, "").replace(/{{[\s\S]*?}}/g, "false");
      html = html.replace(/<link\b[^>]*\b(?:rel="manifest"|href="https?:\/\/)[^>]*>/gi, "");
      html = html.replace(/\/assets\/(leaflet(?:\.markercluster)?\.(?:js|css)|marked\.min\.js|xss\.min\.js|MarkerCluster(?:\.Default)?\.css)/g, "/vendor/$1");
      const injected = fixtureScript(name, pageFixtureBootstrap(name, variant, provider));
      html = html.replace(/(<script\b[^>]*type="module")/, `${injected}\n$1`);
      const filename = `${name}${variant === "default" ? "" : `-${variant}`}.html`;
      await writeFile(resolve(outputDirectory, filename), html);
      cases.push({ name, variant, path: `/${filename}` });
    }
  }
  return cases;
}
