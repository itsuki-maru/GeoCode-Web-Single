// template-scriptsをビルドしてからNodeで実行する。アプリケーションDBへの接続は不要。
import assert from "node:assert/strict";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";
import {
  buildPagesFixture, fixtureTileServers, layers, markers, pagesOutputDirectory,
  printState, repository, templateProject,
} from "./pages-fixture.mjs";
import { createPrototypeServer, prototypeContentSecurityPolicy } from "./serve.mjs";

// 原因調査用の補正は、html2canvasが一時的に作成する複製DOMだけに適用する。
const cloneFix = process.env.VECTOR_PRINT_CLONE_FIX ?? "none";
assert(["none", "gl-overflow-visible", "viewport-overflow-visible"].includes(cloneFix));
const entries = [
  { name: "desktop-v1", source: "legacy", vector: false, mobile: false, paper: "a4-landscape" },
  { name: "desktop-v1-a3", source: "legacy", vector: false, mobile: false, paper: "a3-portrait" },
  { name: "desktop-v2", source: "v2", vector: true, mobile: false, paper: "a3-portrait" },
  { name: "mobile-v2", source: "v2", vector: true, mobile: true, paper: "a4-landscape" },
  { name: "desktop-answer", source: "answer", vector: true, mobile: false, paper: "a3-portrait" },
].filter(entry => !process.env.VECTOR_PRINT_CASES || process.env.VECTOR_PRINT_CASES.split(",").includes(entry.name));
assert(entries.length > 0, "VECTOR_PRINT_CASES must select an existing case");
const evidence = resolve(repository, `target/vector-basemap-printing/evidence${cloneFix === "none" ? "" : `-${cloneFix}`}`);
await mkdir(evidence, { recursive: true });
const pages = await buildPagesFixture();

// 本体の入口とライブラリ資材をそのまま使い、既存のLeafletインスタンスを観測する。
const probe = `<script>
  L.Map.addInitHook(function () { window.__printingMap = this; });
</script>`;
const insertProbe = html => html.replace(/(<script\b[^>]*type="module")/, `${probe}\n$1`);
const readonlyPath = resolve(pagesOutputDirectory, "assets/read-only-map-print.html");
await writeFile(readonlyPath, insertProbe(await readFile(readonlyPath, "utf8")));
await cp(resolve(templateProject, "public/popup-content.css"), resolve(pagesOutputDirectory, "assets/popup-content.css"));

const answerSnapshot = {
  state: { ...printState("2"), markerIds: ["fixture-marker"], shapeIds: [], clusteringEnabled: false },
  bootstrap: {
    page: "form-answer-map", isCluster: false, initialView: printState().view,
    tileServers: fixtureTileServers(), tileOverlays: [], layers, markers, shapes: [],
    answerPreview: {
      answerCount: 1, targetCount: 1, requestId: "answer-print-fixture",
      parentOrigin: "__ORIGIN__", query: {}, targets: ["marker:fixture-marker"],
    },
    popupBodies: {}, popupAnalysis: {},
  },
};
let answerHtml = await readFile(resolve(repository, "src/templates/form-answer-map-print.html"), "utf8");
answerHtml = answerHtml.replace(
  /<script>window\.__ANSWER_PRINT_SESSION__=[\s\S]*?<\/script>/,
  '<script>window.__ANSWER_PRINT_SESSION__={parentOrigin:location.origin,requestId:window.name};</script>',
).replace(/{{[\s\S]*?}}/g, "false").replace(/{%[\s\S]*?%}/g, "");
assert(answerHtml.includes("parentOrigin:location.origin,requestId:window.name"), "Answer template session must be rendered for the local test origin");
await writeFile(resolve(pagesOutputDirectory, "assets/form-answer-map-print-fixture.html"), insertProbe(answerHtml));
await writeFile(resolve(pagesOutputDirectory, "answer-print-host.html"), `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><title>回答地図の印刷受入</title>
<style>html,body{height:100%;margin:0}iframe{border:0;width:100%;height:100%}</style></head>
<body><script>
  const snapshot = ${JSON.stringify(answerSnapshot).replaceAll("<", "\\u003c")};
  snapshot.bootstrap.answerPreview.parentOrigin = location.origin;
  const frame = document.createElement('iframe');
  frame.name = 'print-answer-fixture'; frame.title = '回答地図の印刷プレビュー';
  window.addEventListener('message', event => {
    if (event.source !== frame.contentWindow || event.origin !== location.origin || event.data?.requestId !== frame.name) return;
    if (event.data.type === 'printReady') frame.contentWindow.postMessage({type:'printInitialize',requestId:frame.name,snapshot},location.origin);
  });
  frame.src = '/assets/form-answer-map-print-fixture.html'; document.body.append(frame);
</script></body></html>`);

const server = await createPrototypeServer({ root: pagesOutputDirectory });
const results = [];
let browser;

async function bounded(promise, label, timeout = 45000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error(`${label} did not finish`)), timeout);
    })]);
  } finally { clearTimeout(timer); }
}

function instrumentPrintSession({ cloneFix }) {
  const data = window.__printAcceptance = { messages: [], initialized: [], nativeCalls: [], violations: [], cloneGeometry: [], pdfRenderings: [] };
  const geometry = doc => {
    const view = doc.defaultView;
    return ["#print-viewport", "#print-paper-space", "#print-paper", "#map", ".leaflet-map-pane", ".leaflet-tile-pane", ".leaflet-gl-layer", ".maplibregl-canvas-container", "canvas[data-geocode-maplibre-canvas]", "img[data-geocode-maplibre-print-image]"].flatMap(selector => [...doc.querySelectorAll(selector)].map(node => {
      const style = view.getComputedStyle(node);
      return { selector, rect: node.getBoundingClientRect().toJSON(), width: node.clientWidth, height: node.clientHeight,
        transform: style.transform, transformOrigin: style.transformOrigin, position: style.position,
        overflowX: style.overflowX, overflowY: style.overflowY, top: style.top, left: style.left, scrollTop: node.scrollTop };
    }));
  };
  window.__printGeometry = geometry;
  const appendChild = Node.prototype.appendChild;
  Node.prototype.appendChild = function (node) {
    if (node.nodeName === "IFRAME" && node.classList?.contains("html2canvas-container")) {
      node.addEventListener("load", () => {
        const doc = node.contentDocument;
        if (!doc?.querySelector("#print-paper")) return;
        data.cloneGeometry.push({ phase: "loaded-before-onclone", geometry: geometry(doc) });
        if (cloneFix !== "none") {
          const style = doc.createElement("style");
          style.textContent = cloneFix === "gl-overflow-visible"
            ? ".leaflet-gl-layer.maplibregl-map{overflow:visible!important}"
            : "#print-viewport,#print-paper-space{overflow:visible!important}";
          doc.head.append(style);
          data.cloneGeometry.push({ phase: `diagnostic-${cloneFix}`, geometry: geometry(doc) });
        }
      });
    }
    return Reflect.apply(appendChild, this, [node]);
  };
  const removeChild = Node.prototype.removeChild;
  Node.prototype.removeChild = function (node) {
    if (node.nodeName === "IFRAME" && node.classList?.contains("html2canvas-container") && node.contentDocument?.querySelector("#print-paper"))
      data.cloneGeometry.push({ phase: "parsed-before-removal", geometry: geometry(node.contentDocument) });
    return Reflect.apply(removeChild, this, [node]);
  };
  const replaceWith = Element.prototype.replaceWith;
  Element.prototype.replaceWith = function (...nodes) {
    const doc = this.ownerDocument;
    const snapshot = this.matches("canvas[data-geocode-maplibre-canvas]") && nodes.some(node => node?.matches?.("img[data-geocode-maplibre-print-image]"));
    const result = Reflect.apply(replaceWith, this, nodes);
    if (snapshot) data.cloneGeometry.push({ phase: "snapshot-replaced", geometry: geometry(doc) });
    return result;
  };
  const toDataURL = HTMLCanvasElement.prototype.toDataURL;
  HTMLCanvasElement.prototype.toDataURL = function (...args) {
    const url = Reflect.apply(toDataURL, this, args);
    const samples = data.samplePoints;
    // jsPDFはhtml2canvasの完成画像を取り込む。このcanvasには地図用の識別属性がない。
    if (!this.hasAttribute("data-geocode-maplibre-canvas") && this.width > 1000 && this.height > 700 && samples?.length) {
      const context = this.getContext("2d");
      if (context) data.pdfRenderings.push({ width: this.width, height: this.height, dataUrl: url,
        samples: samples.map(sample => ({ ...sample, actual: [...context.getImageData(Math.floor(sample.x * this.width), Math.floor(sample.y * this.height), 1, 1).data] })) });
    }
    return url;
  };
  document.addEventListener("securitypolicyviolation", event => data.violations.push({ directive: event.effectiveDirective, blocked: event.blockedURI }));
  window.addEventListener("message", event => {
    if (event.origin !== location.origin || !/^print(?:Ready|Initialize|Initialized|Error|Close)$/.test(event.data?.type ?? "")) return;
    data.messages.push({ type: event.data.type, requestId: event.data.requestId });
    if (event.data.type === "printInitialize") data.initialized.push(JSON.parse(JSON.stringify(event.data.snapshot)));
  });
  const readNative = () => {
    const canvases = [...document.querySelectorAll("#map canvas[data-geocode-maplibre-canvas]")];
    const images = [...document.querySelectorAll("#map img[data-geocode-maplibre-print-image]")];
    return {
      canvasCount: canvases.length,
      canvasDisplays: canvases.map(canvas => getComputedStyle(canvas).display),
      sameCanvases: canvases.every((canvas, index) => canvas === window.__nativeOriginalCanvases?.[index]),
      imageCount: images.length,
      decodedImages: images.filter(image => image.complete && image.naturalWidth > 0 && image.naturalHeight > 0 && image.src.startsWith("data:image/png")).length,
      imageDimensions: images.map(image => ({ width: image.naturalWidth, height: image.naturalHeight })),
      imageRects: images.map(image => image.getBoundingClientRect().toJSON()),
      mapRect: document.querySelector("#map")?.getBoundingClientRect().toJSON(),
      viewportInert: document.querySelector("#print-viewport")?.inert,
      settingsInert: document.querySelector("#print-settings")?.inert,
      title: document.querySelector("#print-title")?.textContent,
    };
  };
  // OSの印刷ダイアログを開く代わりに、ブラウザー印刷の準備処理を観測する。
  window.print = () => {
    window.dispatchEvent(new Event("beforeprint"));
    const during = readNative();
    window.dispatchEvent(new Event("afterprint"));
    data.nativeCalls.push({ during, after: readNative() });
  };
}

async function readPreview(frame) {
  return bounded(frame.evaluate(() => {
    const map = window.__printingMap;
    const controller = map?._geocodeBasemap;
    let bridge;
    map?.eachLayer(layer => { if (typeof layer.getMaplibreMap === "function") bridge = layer; });
    const gl = bridge?.getMaplibreMap();
    const canvas = gl?.getCanvas();
    const mapElement = document.getElementById("map");
    const paper = document.getElementById("print-paper");
    const images = [...mapElement.querySelectorAll("img.leaflet-tile, .leaflet-marker-pane img, .leaflet-shadow-pane img")];
    const initialize = window.__printAcceptance.initialized.at(-1);
    return {
      selectedId: controller?.getSelectedId(), pending: controller?.isPending(),
      checkedIds: [...document.querySelectorAll(".tile-radio:checked")].map(input => input.value),
      canvasCount: mapElement.querySelectorAll("canvas[data-geocode-maplibre-canvas]").length,
      printImages: mapElement.querySelectorAll("img[data-geocode-maplibre-print-image]").length,
      markerCount: mapElement.querySelectorAll(".leaflet-marker-pane .leaflet-marker-icon").length,
      missingImages: images.filter(image => !image.complete || image.naturalWidth === 0).map(image => image.getAttribute("src")),
      attribution: mapElement.querySelector(".leaflet-control-attribution")?.textContent,
      title: document.getElementById("print-title").textContent,
      status: document.getElementById("print-status").textContent,
      paper: { selected: document.getElementById("print-size").value, width: paper.style.width, height: paper.style.height, pixels: { width: paper.offsetWidth, height: paper.offsetHeight } },
      map: { width: mapElement.clientWidth, height: mapElement.clientHeight, size: map.getSize(), center: map.getCenter(), projectedCenter: map.project(map.getCenter(), map.getZoom()), zoom: map.getZoom() },
      gl: gl ? {
        loaded: gl.loaded(), tilesLoaded: gl.areTilesLoaded(), center: gl.getCenter(), zoom: gl.getZoom(),
        width: canvas.clientWidth, height: canvas.clientHeight,
        bufferWidth: canvas.width, bufferHeight: canvas.height,
        containerWidth: bridge.getContainer().clientWidth, containerHeight: bridge.getContainer().clientHeight,
        padding: bridge.options.padding,
        featureLayers: [...new Set(gl.queryRenderedFeatures().map(feature => feature.layer.id))],
        canvasRect: canvas.getBoundingClientRect().toJSON(), mapRect: mapElement.getBoundingClientRect().toJSON(),
      } : null,
      initialization: initialize ? {
        requestId: window.name, version: initialize.version, sourcePage: initialize.sourcePage,
        snapshotShare: initialize.snapshotShare, state: initialize.state,
        tileServers: initialize.tileServers ?? initialize.bootstrap?.tileServers,
      } : null,
      nativeCalls: window.__printAcceptance.nativeCalls,
      geometry: window.__printGeometry(document),
      violations: window.__printAcceptance.violations,
    };
  }), "Reading the print preview", 10000);
}

async function waitForReady(frame) {
  await frame.waitForFunction(() => {
    const status = document.getElementById("print-status");
    return status?.textContent === "印刷準備完了" && document.getElementById("pdf-export")?.disabled === false && document.getElementById("print-submit")?.disabled === false;
  }, undefined, { timeout: 45000 });
}

function checkPreview(state, entry) {
  assert.equal(state.selectedId, entry.vector ? "2" : "1");
  assert.equal(state.pending, false);
  assert.deepEqual(state.checkedIds, [state.selectedId]);
  assert.equal(state.markerCount, 1, "The archived Leaflet marker must be present in print");
  assert.deepEqual(state.missingImages, [], "Unfetched/failed required image assets cannot be printed as success");
  assert.equal(state.status, "印刷準備完了");
  assert.equal(state.map.width, state.map.size.x);
  assert.equal(state.map.height, state.map.size.y);
  assert.deepEqual(state.violations, []);
  assert.equal(state.printImages, 0);
  assert.equal(state.canvasCount, entry.vector ? 1 : 0);
  if (entry.vector) {
    assert.equal(state.gl.loaded, true);
    assert.equal(state.gl.tilesLoaded, true);
    for (const feature of ["roads", "labels", "facility"]) assert(state.gl.featureLayers.includes(feature), `${feature} must render before export`);
    assert(state.attribution.includes("Vector background fixture"));
    assert(state.attribution.includes("GeoCode-Web synthetic fixture"));
    assert(!state.attribution.includes("Legacy raster fixture"));
    assert.equal(state.gl.width, state.gl.containerWidth);
    assert.equal(state.gl.height, state.gl.containerHeight);
    const canvas = state.gl.canvasRect, map = state.gl.mapRect;
    assert(canvas.left <= map.left + 1 && canvas.top <= map.top + 1 && canvas.right >= map.right - 1 && canvas.bottom >= map.bottom - 1,
      "The live GL canvas must cover all four sides of the print map");
    assert(Math.abs(state.gl.width - state.map.width * (1 + 2 * state.gl.padding)) <= 2, "The GL width must resize with Leaflet");
    assert(Math.abs(state.gl.height - state.map.height * (1 + 2 * state.gl.padding)) <= 2, "The GL height must resize with Leaflet");
    assert(Math.abs(state.gl.zoom - (state.map.zoom - 1)) < 0.000001, "Bridge zoom must stay aligned after paper changes");
    assert(Math.abs(state.gl.center.lat - state.map.center.lat) < 0.000001);
    assert(Math.abs(state.gl.center.lng - state.map.center.lng) < 0.000001);
    assert.equal(state.initialization.tileServers["2"].style_url, "/fixtures/style.json", "The archived style must reach the print entry");
  } else {
    assert.equal(state.gl, null);
    assert(state.attribution.includes("Legacy raster fixture"));
    assert.equal(Object.hasOwn(state.initialization.tileServers["1"], "kind"), false, "Archived v1 must remain a legacy raster definition");
  }
}

function checkPreservedView(before, after) {
  assert.equal(after.zoom, before.zoom);
  const x = after.projectedCenter.x - before.projectedCenter.x;
  const y = after.projectedCenter.y - before.projectedCenter.y;
  const distance = Math.hypot(x, y);
  // Leaflet 1.9.4はsetView時にピクセル原点を丸め、移動オフセットを切り捨てる。
  // 緯度・ズームで変動する経緯度の許容誤差を避け、実際のCRSワールドピクセルを比較する。
  assert(distance <= 1 + 0.0000001, `Paper resize moved the center by ${distance} world pixels`);
  return { x, y, distance };
}

async function nativePrint(frame, vector) {
  await frame.evaluate(() => {
    window.__nativeOriginalCanvases = [...document.querySelectorAll("#map canvas[data-geocode-maplibre-canvas]")];
  });
  const before = await frame.evaluate(() => window.__printAcceptance.nativeCalls.length);
  await frame.locator("#print-submit").click();
  await frame.waitForFunction(before => window.__printAcceptance.nativeCalls.length > before, before, { timeout: 20000 });
  const call = await frame.evaluate(() => window.__printAcceptance.nativeCalls.at(-1));
  assert.equal(call.during.canvasCount, vector ? 1 : 0);
  assert.equal(call.during.sameCanvases, true);
  assert.equal(call.during.imageCount, vector ? 1 : 0);
  assert.equal(call.during.decodedImages, vector ? 1 : 0, "window.print must see fully decoded PNG replacements");
  if (vector) {
    assert.deepEqual(call.during.canvasDisplays, ["none"]);
    assert.equal(call.during.viewportInert, true);
    assert.equal(call.during.settingsInert, true);
    const image = call.during.imageRects[0], map = call.during.mapRect;
    assert(image.left <= map.left + 1 && image.top <= map.top + 1 && image.right >= map.right - 1 && image.bottom >= map.bottom - 1,
      "The decoded native-print image must cover all four sides of the map");
  }
  assert.equal(call.after.imageCount, 0);
  assert.equal(call.after.sameCanvases, true);
  assert(call.after.canvasDisplays.every(display => display !== "none"));
  assert.equal(call.after.viewportInert, false);
  assert.equal(call.after.settingsInert, false);
  await waitForReady(frame);
  return call;
}

async function preparePdfSamples(frame) {
  await frame.evaluate(() => {
    const paper = document.getElementById("print-paper"), map = document.getElementById("map");
    const paperRect = paper.getBoundingClientRect(), mapRect = map.getBoundingClientRect();
    const glCanvas = map.querySelector("canvas[data-geocode-maplibre-canvas]");
    const pixel = document.createElement("canvas");
    pixel.width = pixel.height = 1;
    const context = pixel.getContext("2d", { willReadFrequently: true });
    const samplePoints = [];
    for (const mapX of [0.05, 0.95]) for (const mapY of [0.03, 0.12, 0.28, 0.9]) {
      const screenX = mapRect.left + mapRect.width * mapX, screenY = mapRect.top + mapRect.height * mapY;
      const source = glCanvas ?? [...map.querySelectorAll("img.leaflet-tile-loaded")].reverse().find(image => {
        const rect = image.getBoundingClientRect();
        return image.complete && image.naturalWidth && rect.left <= screenX && rect.right > screenX && rect.top <= screenY && rect.bottom > screenY;
      });
      if (!source) throw Error(`No loaded background at map sample ${mapX},${mapY}`);
      const rect = source.getBoundingClientRect(), width = source.naturalWidth ?? source.width, height = source.naturalHeight ?? source.height;
      context.clearRect(0, 0, 1, 1);
      context.drawImage(source, Math.floor((screenX - rect.left) / rect.width * width), Math.floor((screenY - rect.top) / rect.height * height), 1, 1, 0, 0, 1, 1);
      const expected = [...context.getImageData(0, 0, 1, 1).data];
      if (expected[3] !== 255) throw Error("The synthetic background sample must be opaque before export");
      samplePoints.push({ label: `${mapX},${mapY}`, x: (screenX - paperRect.left) / paperRect.width, y: (screenY - paperRect.top) / paperRect.height, expected });
    }
    window.__printAcceptance.samplePoints = samplePoints;
  });
}

function checkPdfRendering(rendering, vector) {
  assert(rendering, "The actual PDF exporter must serialize the completed html2canvas image");
  assert.equal(rendering.samples.length, 8);
  for (const sample of rendering.samples) {
    assert(!sample.actual.slice(0, 3).every(value => Math.abs(value - 221) <= 2), `PDF background sample ${sample.label} exposes Leaflet gray instead of the loaded background`);
    assert.equal(sample.actual[3], 255);
    if (vector) assert(Math.max(...sample.actual.map((value, index) => Math.abs(value - sample.expected[index]))) <= 8,
      `PDF background sample ${sample.label} differs from the actual GL canvas: ${sample.actual} vs ${sample.expected}`);
  }
}

try {
  browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--enable-unsafe-swiftshader"] });
  for (const entry of entries) {
    const context = await browser.newContext({ viewport: entry.mobile ? { width: 430, height: 932 } : { width: 1440, height: 1100 }, isMobile: entry.mobile, hasTouch: entry.mobile, acceptDownloads: true });
    await context.addInitScript(instrumentPrintSession, { cloneFix });
    const extraDataRequests = [];
    await context.route("**/marker/read/all?*", route => { extraDataRequests.push(route.request().url()); return route.fulfill({ contentType: "application/json", body: JSON.stringify(markers) }); });
    await context.route("**/shapes?*", route => { extraDataRequests.push(route.request().url()); return route.fulfill({ contentType: "application/json", body: "[]" }); });
    await context.route("**/favicon.ico", route => route.fulfill({ status: 204 }));
    await context.route("**/apple-touch-icon-*.png", route => route.fulfill({ status: 204 }));
    const page = await context.newPage();
    page.setDefaultTimeout(35000);
    const errors = [], external = [], httpFailures = [], networkFailures = [], abortedRequests = [], workers = [];
    let closing = false;
    page.on("pageerror", error => { if (!closing) errors.push({ message: error.message, stack: error.stack }); });
    context.on("response", response => { if (!closing && response.status() >= 400) httpFailures.push({ url: response.url(), status: response.status() }); });
    context.on("requestfailed", request => {
      if (closing) return;
      const failed = { url: request.url(), error: request.failure()?.errorText };
      (failed.error === "net::ERR_ABORTED" ? abortedRequests : networkFailures).push(failed);
    });
    context.on("request", request => { if (!closing && /^https?:/.test(request.url()) && !request.url().startsWith(server.url)) external.push(request.url()); });
    page.on("worker", worker => workers.push(worker.url()));
    const result = { ...entry, passed: false, sizes: [] };
    results.push(result);
    let frame;
    try {
      let archived;
      if (entry.source === "answer") {
        const response = await page.goto(`${server.url}/answer-print-host.html`, { waitUntil: "networkidle" });
        assert.equal(response.headers()["content-security-policy"], prototypeContentSecurityPolicy);
        await page.locator("iframe").waitFor();
      } else {
        const fixture = pages.find(item => item.name === "temporary-map" && item.variant === entry.source);
        assert(fixture);
        const response = await page.goto(`${server.url}${fixture.path}`, { waitUntil: "networkidle" });
        assert.equal(response.headers()["content-security-policy"], prototypeContentSecurityPolicy);
        await page.waitForFunction(() => Boolean(window.__pagesProbe?.controller()));
        await bounded(page.evaluate(() => window.__pagesProbe.controller().whenReady()), "Preparing the archived share");
        assert.equal(await page.evaluate(() => window.__pagesProbe.controller().getSelectedId()), entry.vector ? "2" : "1");
        archived = await page.evaluate(() => JSON.stringify(window.__GEOCODE_MAP_BOOTSTRAP__.shareSnapshot));
        await page.getByRole("button", { name: "地図を印刷", exact: true }).click();
        await page.locator("dialog.map-print-host iframe").waitFor();
      }
      // FrameLocatorにはevaluateがないため、本体の子フレーム自体を取得する。
      const iframe = entry.source === "answer" ? page.locator("iframe") : page.locator("dialog.map-print-host iframe");
      const iframeHandle = await iframe.elementHandle();
      frame = await iframeHandle.contentFrame();
      assert(frame);
      await frame.locator("#print-size").waitFor();
      await frame.locator("#print-title-input").fill(`背景印刷検証 ${entry.name}`);
      await waitForReady(frame);
      const initial = await readPreview(frame);
      checkPreview(initial, entry);
      assert.equal(initial.paper.selected, "a4-landscape");
      assert.equal(initial.paper.width, "297mm");
      assert.equal(initial.paper.height, "210mm");
      if (entry.source !== "answer") {
        assert.equal(initial.initialization.version, entry.source === "legacy" ? 1 : 2);
        assert.equal(initial.initialization.sourcePage, "temporary-map");
        assert.equal(initial.initialization.snapshotShare, true);
      }
      result.sizes.push(initial);
      if (entry.vector || entry.paper === "a3-portrait") {
        await frame.locator("#print-size").selectOption("a3-portrait");
        await waitForReady(frame);
        const portrait = await readPreview(frame);
        checkPreview(portrait, entry);
        assert.equal(portrait.paper.width, "297mm");
        assert.equal(portrait.paper.height, "420mm");
        assert(portrait.map.height > initial.map.height, "A3 portrait must resize the map and GL canvas");
        portrait.centerDriftPixels = checkPreservedView(initial.map, portrait.map);
        result.sizes.push(portrait);
        if (entry.paper === "a4-landscape") {
          await frame.locator("#print-size").selectOption("a4-landscape");
          await waitForReady(frame);
          const restored = await readPreview(frame);
          checkPreview(restored, entry);
          assert.equal(restored.map.width, initial.map.width);
          assert.equal(restored.map.height, initial.map.height);
          restored.centerDriftPixels = checkPreservedView(initial.map, restored.map);
          result.sizes.push(restored);
        }
      }
      result.nativePrint = await nativePrint(frame, entry.vector);
      await preparePdfSamples(frame);
      await frame.locator("#pdf-export").click();
      await frame.locator(".pdf-output [data-status]").filter({ hasText: "PDFを作成しました。" }).waitFor({ timeout: 60000 });
      const download = page.waitForEvent("download", { timeout: 60000 });
      await frame.locator(".pdf-output [data-save]").click();
      const file = await download;
      const path = resolve(evidence, `${entry.name}-${entry.paper}.pdf`);
      await file.saveAs(path);
      const bytes = await readFile(path);
      assert.equal(bytes.subarray(0, 4).toString(), "%PDF");
      assert(bytes.length > 20000, "The output must contain the rendered map image");
      result.pdf = { path, bytes: bytes.length, paper: entry.paper };
      const renderings = await frame.evaluate(() => window.__printAcceptance.pdfRenderings);
      assert(renderings.length > 0, "The PDF image must be observed");
      const rendering = renderings.at(-1);
      await writeFile(resolve(evidence, `${entry.name}-${entry.paper}-canvas.png`), Buffer.from(rendering.dataUrl.split(",")[1], "base64"));
      result.pdfRendering = { ...rendering, dataUrl: undefined };
      result.cloneGeometry = await frame.evaluate(() => window.__printAcceptance.cloneGeometry);
      checkPdfRendering(rendering, entry.vector);
      await waitForReady(frame);
      checkPreview(await readPreview(frame), entry);
      await page.screenshot({ path: resolve(evidence, `${entry.name}-preview.png`), fullPage: true });
      const parentMessages = await page.evaluate(() => window.__printAcceptance.messages);
      assert(parentMessages.some(message => message.type === "printReady"));
      assert(parentMessages.some(message => message.type === "printInitialized"));
      assert(!parentMessages.some(message => message.type === "printError"));
      result.sessionMessages = parentMessages;
      assert.deepEqual(extraDataRequests, [], "Print snapshots must not fetch additional marker/shape records");
      assert.deepEqual(errors, []);
      assert.deepEqual(external, []);
      assert.deepEqual(httpFailures, []);
      assert.deepEqual(networkFailures, []);
      assert.deepEqual(await page.evaluate(() => window.__printAcceptance.violations), []);
      if (archived !== undefined)
        assert.equal(await page.evaluate(() => JSON.stringify(window.__GEOCODE_MAP_BOOTSTRAP__.shareSnapshot)), archived, "Printing must not modify an archived share snapshot");
      if (!entry.vector) assert.equal(workers.length, 0, "Legacy raster printing must not load MapLibre Workers");
      assert(workers.every(url => url.startsWith(`${server.url}/assets/template-maplibre-gl-worker-`)));
      result.workers = workers;
      result.abortedRequests = abortedRequests;
      result.passed = true;
      console.log(`${entry.name}: passed; ${bytes.length} PDF bytes`);
    } catch (error) {
      result.error = String(error);
      result.errors = errors;
      result.external = external;
      result.httpFailures = httpFailures;
      result.networkFailures = networkFailures;
      result.extraDataRequests = extraDataRequests;
      result.lastPreview = frame?.evaluate ? await readPreview(frame).catch(() => null) : null;
      result.cloneGeometry ??= frame?.evaluate ? await frame.evaluate(() => window.__printAcceptance.cloneGeometry).catch(() => []) : [];
      result.sessionMessages = await bounded(page.evaluate(() => window.__printAcceptance.messages), "Reading failed print session", 5000).catch(() => []);
      await page.screenshot({ path: resolve(evidence, `${entry.name}-failure.png`), fullPage: true, timeout: 5000 }).catch(() => {});
      console.log(`${entry.name}: FAILED ${String(error)}`);
    } finally {
      closing = true;
      await context.close();
    }
  }
} finally {
  const browserVersion = browser?.version();
  await browser?.close();
  await writeFile(resolve(evidence, "results.json"), JSON.stringify({
    timestamp: new Date().toISOString(), browserVersion, cloneFix, policy: prototypeContentSecurityPolicy,
    methodology: "Production shared/answer print entries and PDF exporter with synthetic data. window.print is stubbed to observe decoded canvas replacements and afterprint restoration; no physical printer or real mobile device is exercised. Paper changes allow at most one actual CRS world pixel of Leaflet integer-coordinate rounding at an unchanged zoom. Paper-change cancellations are recorded separately while current assets must reach complete print readiness. The actual canvas serialized by jsPDF is sampled against the live opaque synthetic background, including the top corners; independent Poppler visual inspection remains required. Optional clone fixes are diagnostic only and are reported separately from the unmodified production baseline.",
    results, requests: server.requests,
  }, null, 2));
  await server.close();
}
assert(results.length === entries.length && results.every(result => result.passed), `Print acceptance failed; see ${resolve(evidence, "results.json")}`);
