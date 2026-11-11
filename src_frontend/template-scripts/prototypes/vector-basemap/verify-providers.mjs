// 明示指定した配信元の受入検証。アプリケーションAPIにはローカルの自作データを使用する。
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile, cp } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { buildPagesFixture, repository, templateProject, markers } from "./pages-fixture.mjs";
import { createPrototypeServer } from "./serve.mjs";
import { getProvider } from "./provider-profiles.mjs";

const provider = getProvider(process.argv[2] ?? process.env.VECTOR_PROVIDER ?? "openfreemap-liberty");
const base = resolve(repository, "target/vector-basemap-providers", provider.id);
const site = resolve(base, "site"), evidence = resolve(base, "evidence");
await mkdir(evidence, { recursive: true });
await buildPagesFixture({ outputDirectory: site, evidenceDirectory: evidence, provider });
const printPath = resolve(site, "assets/read-only-map-print.html");
const printHtml = await readFile(printPath, "utf8");
await writeFile(printPath, printHtml.replace(/(<script\b[^>]*type="module")/,
  '<script>L.Map.addInitHook(function(){window.__printingMap=this;});</script>\n$1'));
await cp(resolve(templateProject, "public/popup-content.css"), resolve(site, "assets/popup-content.css"));
const server = await createPrototypeServer({ root: site, allowedOrigins: provider.allowedOrigins });
const allCases = [
  { name: "desktop", path: "/map-anather.html", mobile: false, shared: false, print: true },
  { name: "mobile", path: "/map-mobile.html", mobile: true, shared: false },
  { name: "shared-v2", path: "/temporary-map-v2.html", mobile: false, shared: true },
  { name: "overview", path: "/map-anather.html", mobile: false, shared: false,
    view: { latitude: 39.2, longitude: 138.5, zoom: 6 } },
];
const selectedCases = process.env.VECTOR_PROVIDER_CASES?.split(",");
if (selectedCases) assert(selectedCases.every(name => allCases.some(entry => entry.name === name)), "VECTOR_PROVIDER_CASES must name an existing case");
const cases = allCases.filter(entry => !selectedCases || selectedCases.includes(entry.name));
const report = resolve(evidence, selectedCases ? `results-${cases.map(entry => entry.name).join("-")}.json` : "results.json");
const results = [];
let browser;
const safeUrl = value => { const url = new URL(value); return `${url.origin}${url.pathname}`; };

async function state(page) {
  return page.evaluate(() => {
    const map = window.__pagesProbe.map(), controller = window.__pagesProbe.controller(), gl = window.__pagesProbe.gl();
    const features = gl?.queryRenderedFeatures() ?? [];
    return {
      selectedId: controller.getSelectedId(), pending: controller.isPending(),
      checkedIds: [...document.querySelectorAll(".tile-radio:checked")].map(input => input.value),
      canvasCount: document.querySelectorAll("canvas[data-geocode-maplibre-canvas]").length,
      loaded: gl?.loaded(), tilesLoaded: gl?.areTilesLoaded(),
      featureCount: features.length,
      symbolLayers: [...new Set(features.filter(feature => feature.layer.type === "symbol").map(feature => feature.layer.id))],
      symbolExamples: features.filter(feature => feature.layer.type === "symbol").slice(0, 12).map(feature => ({ layer: feature.layer.id, names: Object.fromEntries(Object.entries(feature.properties ?? {}).filter(([key]) => /^(?:name|name:ja|name:latin|name:nonlatin|name_en|name_ja)$/.test(key))) })),
      renderedLayerTypes: [...new Set(features.map(feature => feature.layer.type))],
      attribution: document.querySelector(".leaflet-control-attribution")?.textContent,
      sourceAttributions: gl ? Object.keys(gl.getStyle().sources).map(id => ({ id, attribution: gl.getSource(id)?.attribution ?? "" })) : [],
      center: map.getCenter(), zoom: map.getZoom(),
      sameLeaflet: !gl || Object.values(map._layers).filter(layer => layer.getMaplibreMap).every(layer => layer instanceof L.Layer),
      violations: window.__pagesViolations,
    };
  });
}

async function ready(page) {
  await page.waitForFunction(() => Boolean(window.__pagesProbe?.controller()));
  await page.evaluate(() => window.__pagesProbe.controller().whenReady());
}
async function select(page, id) {
  const changed = await page.evaluate(id => window.__pagesProbe.controller().select(id), id);
  await page.evaluate(() => window.__pagesProbe.controller().whenReady());
  return changed;
}
async function vectorReady(page) {
  await page.waitForFunction(() => window.__pagesProbe.controller().getSelectedId() === "2" && !window.__pagesProbe.controller().isPending() && window.__pagesProbe.gl()?.loaded() && window.__pagesProbe.gl().areTilesLoaded());
}
function checkVector(value) {
  assert.equal(value.selectedId, "2");
  assert.equal(value.pending, false);
  assert.deepEqual(value.checkedIds, ["2"]);
  assert.equal(value.canvasCount, 1);
  assert.equal(value.loaded, true);
  assert.equal(value.tilesLoaded, true);
  assert(value.featureCount > 0, "The real vector source must render features");
  assert(value.symbolLayers.length > 0, "The real provider must render label/icon symbol layers");
  assert.equal(value.sameLeaflet, true);
  for (const text of provider.attributionTexts) assert(value.attribution.includes(text), `Required attribution is missing: ${text}`);
  assert.deepEqual(value.violations, []);
}
async function installApiRoutes(context) {
  await context.route("**/marker/read/all?*", route => route.fulfill({ contentType: "application/json", body: JSON.stringify(markers) }));
  await context.route("**/shapes?*", route => route.fulfill({ contentType: "application/json", body: "[]" }));
  await context.route("**/favicon.ico", route => route.fulfill({ status: 204 }));
  await context.route("**/apple-touch-icon-*.png", route => route.fulfill({ status: 204 }));
  await context.addInitScript(() => {
    window.__providerNativeCalls = [];
    window.__providerViolations = [];
    window.__providerPrintEvents = [];
    const printState = () => ({
      status: document.getElementById("print-status")?.textContent,
      pdfStatus: document.querySelector(".pdf-output [data-status]")?.textContent,
      submitDisabled: document.getElementById("print-submit")?.disabled,
      pdfDisabled: document.getElementById("pdf-export")?.disabled,
      bodyClass: document.body?.className,
      settingsInert: document.getElementById("print-settings")?.inert,
      viewportInert: document.getElementById("print-viewport")?.inert,
    });
    const record = (type, extra = {}) => {
      window.__providerPrintEvents.push({ at: performance.now(), type, ...printState(), ...extra });
      if (window.__providerPrintEvents.length > 100) window.__providerPrintEvents.shift();
    };
    window.__providerRecordPrint = record;
    for (const type of ["pointerdown", "mousedown", "click"])
      document.addEventListener(type, event => {
        if (event.target?.closest?.("#print-submit,#pdf-export")) record(type, { target: event.target.closest("button").id });
      }, true);
    document.addEventListener("securitypolicyviolation", event => window.__providerViolations.push({ directive: event.effectiveDirective, blocked: event.blockedURI }));
    window.print = () => {
      record("native-print");
      const canvases = [...document.querySelectorAll("canvas[data-geocode-maplibre-canvas]")];
      const images = [...document.querySelectorAll("img[data-geocode-maplibre-print-image]")];
      const during = { canvases: canvases.length, images: images.length, decodedImages: images.filter(image => image.complete && image.naturalWidth > 0).length, hiddenCanvases: canvases.every(canvas => getComputedStyle(canvas).display === "none") };
      window.dispatchEvent(new Event("beforeprint"));
      window.dispatchEvent(new Event("afterprint"));
      window.__providerNativeCalls.push({ during, after: { images: document.querySelectorAll("img[data-geocode-maplibre-print-image]").length, sameCanvases: canvases.every(canvas => canvas.isConnected && getComputedStyle(canvas).display !== "none") } });
      record("native-afterprint");
    };
  });
}

async function printDiagnostics(frame) {
  return frame.evaluate(() => {
    const map = window.__printingMap, controller = map?._geocodeBasemap;
    let gl; map?.eachLayer(layer => { if (layer.getMaplibreMap) gl = layer.getMaplibreMap(); });
    return {
      at: performance.now(), lastResume: window.__providerLastResume,
      status: document.getElementById("print-status")?.textContent,
      pdfStatus: document.querySelector(".pdf-output [data-status]")?.textContent,
      submitDisabled: document.getElementById("print-submit")?.disabled,
      pdfDisabled: document.getElementById("pdf-export")?.disabled,
      cancelHidden: document.querySelector(".pdf-output [data-cancel]")?.hidden,
      saveHidden: document.querySelector(".pdf-output [data-save]")?.hidden,
      bodyClass: document.body.className,
      viewportInert: document.getElementById("print-viewport")?.inert,
      settingsInert: document.getElementById("print-settings")?.inert,
      selectedId: controller?.getSelectedId(), pending: controller?.isPending(),
      loaded: gl?.loaded(), tilesLoaded: gl?.areTilesLoaded(),
      native: window.__providerNativeCalls, events: window.__providerPrintEvents,
    };
  });
}

async function printPdf(page, result) {
  const progress = result.printProgress = { phase: "opening", snapshots: [] };
  await page.getByRole("checkbox", { name: "Fixture objects", exact: true }).check({ force: true });
  await page.locator(".leaflet-marker-icon").first().waitFor({ state: "visible" });
  await page.getByRole("button", { name: "地図を印刷", exact: true }).click();
  const iframe = page.locator("dialog.map-print-host iframe");
  await iframe.waitFor();
  const frame = await (await iframe.elementHandle()).contentFrame();
  assert(frame);
  await frame.waitForFunction(() => Boolean(window.__printingMap));
  await frame.evaluate(() => {
    const map = window.__printingMap;
    for (const type of ["printpause", "printresume", "basemaploadingchange", "movestart", "moveend", "zoomstart", "zoomend"])
      map.on(type, () => {
        if (type === "printresume") window.__providerLastResume = performance.now();
        window.__providerRecordPrint(type);
      });
    const observer = new MutationObserver(() => window.__providerRecordPrint("status-change"));
    observer.observe(document.getElementById("print-status"), { childList: true, subtree: true });
    observer.observe(document.querySelector(".pdf-output"), { childList: true, subtree: true, attributes: true, attributeFilter: ["disabled", "hidden"] });
  });
  await frame.locator("#print-size").selectOption("a3-portrait");
  await frame.locator("#print-title-input").fill(`${provider.label} 実配信検証`);
  await frame.waitForFunction(() => document.getElementById("print-status")?.textContent === "印刷準備完了" && document.getElementById("pdf-export")?.disabled === false);
  const printState = await frame.evaluate(() => {
    const map = window.__printingMap, controller = map._geocodeBasemap;
    let gl; map.eachLayer(layer => { if (layer.getMaplibreMap) gl = layer.getMaplibreMap(); });
    const canvas = gl.getCanvas(), mapElement = document.getElementById("map");
    return { selectedId: controller.getSelectedId(), attribution: document.querySelector(".leaflet-control-attribution")?.textContent, markers: document.querySelectorAll(".leaflet-marker-icon").length,
      canvas: canvas.getBoundingClientRect().toJSON(), map: mapElement.getBoundingClientRect().toJSON(),
      loaded: gl.loaded(), tilesLoaded: gl.areTilesLoaded(), featureCount: gl.queryRenderedFeatures().length };
  });
  assert.equal(printState.selectedId, "2");
  assert.equal(printState.markers, 1);
  assert(printState.loaded && printState.tilesLoaded && printState.featureCount > 0);
  assert(printState.canvas.top <= printState.map.top + 1 && printState.canvas.bottom >= printState.map.bottom - 1);
  for (const text of provider.attributionTexts) assert(printState.attribution.includes(text));
  progress.phase = "native-print";
  await frame.locator("#print-submit").click();
  await frame.waitForFunction(() => window.__providerNativeCalls.length === 1);
  const native = await frame.evaluate(() => window.__providerNativeCalls[0]);
  assert.deepEqual(native.during, { canvases: 1, images: 1, decodedImages: 1, hiddenCanvases: true });
  assert.deepEqual(native.after, { images: 0, sameCanvases: true });
  progress.snapshots.push({ phase: "after-native", ...await printDiagnostics(frame) });
  // 実際の操作再開と、アプリケーションが設ける700msの表示安定待ちを観測してから、
  // PDFボタンを1回クリックする。
  progress.phase = "native-resume-settling";
  await frame.waitForFunction(() => {
    const map = window.__printingMap, controller = map?._geocodeBasemap;
    let gl; map?.eachLayer(layer => { if (layer.getMaplibreMap) gl = layer.getMaplibreMap(); });
    return window.__providerLastResume !== undefined && performance.now() - window.__providerLastResume >= 700 &&
      document.getElementById("print-status")?.textContent === "印刷準備完了" &&
      document.getElementById("print-submit")?.disabled === false && document.getElementById("pdf-export")?.disabled === false &&
      !controller?.isPending() && gl?.loaded() && gl.areTilesLoaded() && !document.body.classList.contains("print-preparing");
  });
  progress.snapshots.push({ phase: "before-pdf-click", ...await printDiagnostics(frame) });
  progress.phase = "pdf-click";
  await frame.locator("#pdf-export").click();
  await frame.waitForFunction(() => Boolean(document.querySelector(".pdf-output [data-status]")?.textContent), undefined, { timeout: 3000 });
  const started = await printDiagnostics(frame);
  progress.snapshots.push({ phase: "after-pdf-click", ...started });
  assert(started.events.some(event => event.type === "click" && event.target === "pdf-export"), "The PDF click must reach the production button");
  assert(started.pdfStatus === "PDFを作成しています…" || started.pdfStatus === "PDFを作成しました。" || started.pdfStatus?.startsWith("PDFを作成できませんでした。"), `Unexpected PDF start state: ${started.pdfStatus}`);
  progress.phase = "pdf-generation";
  await frame.locator(".pdf-output [data-status]").filter({ hasText: "PDFを作成しました。" }).waitFor({ timeout: 60000 });
  const downloadPromise = page.waitForEvent("download");
  await frame.locator("[data-save]").click();
  const download = await downloadPromise;
  const path = resolve(evidence, `${provider.id}-a3-portrait.pdf`);
  await download.saveAs(path);
  const bytes = await readFile(path);
  assert.equal(bytes.subarray(0, 4).toString(), "%PDF");
  assert(bytes.length > 20000);
  await page.screenshot({ path: resolve(evidence, "print-preview.png") });
  assert.deepEqual(await frame.evaluate(() => window.__providerViolations), []);
  progress.phase = "complete";
  await page.locator("dialog.map-print-host").getByRole("button", { name: "閉じる", exact: true }).click();
  return { ...printState, native, pdf: { path, bytes: bytes.length, paper: "a3-portrait" } };
}

try {
  browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--enable-unsafe-swiftshader"] });
  for (const entry of cases) {
    const context = await browser.newContext({ viewport: entry.mobile ? { width: 430, height: 932 } : { width: 1440, height: 1000 }, isMobile: entry.mobile, hasTouch: entry.mobile, acceptDownloads: true });
    await installApiRoutes(context);
    const page = await context.newPage();
    page.setDefaultTimeout(60000);
    const result = { ...entry, passed: false, network: [], pageErrors: [], httpFailures: [], networkFailures: [], unexpectedOrigins: [], workers: [] };
    results.push(result);
    let closing = false;
    const allowed = new Set([server.url, ...provider.allowedOrigins]);
    const canceled = [];
    context.on("request", request => {
      if (!/^https?:/.test(request.url())) return;
      const url = new URL(request.url());
      if (!allowed.has(url.origin)) result.unexpectedOrigins.push(safeUrl(request.url()));
    });
    context.on("response", response => {
      const url = response.url();
      if (!/^https?:/.test(url)) return;
      const entry = { url: safeUrl(url), status: response.status(), type: response.request().resourceType() };
      if (new URL(url).origin !== server.url) result.network.push(entry);
      // ローカルの存在しないスタイルを、切替失敗を起こす検証用データとして使う。
      if (response.status() >= 400 && new URL(url).pathname !== "/fixtures/missing-style.json") result.httpFailures.push(entry);
    });
    context.on("requestfailed", request => {
      const failure = { url: safeUrl(request.url()), error: request.failure()?.errorText };
      if (closing || failure.error?.includes("ERR_ABORTED")) canceled.push(failure);
      else result.networkFailures.push(failure);
    });
    page.on("pageerror", error => result.pageErrors.push(String(error)));
    page.on("worker", worker => result.workers.push(worker.url()));
    try {
      const response = await page.goto(`${server.url}${entry.path}`, { waitUntil: "domcontentloaded" });
      assert.equal(response.headers()["content-security-policy"], server.policy);
      await ready(page);
      const snapshotBefore = entry.shared ? await page.evaluate(() => JSON.stringify(window.__GEOCODE_MAP_BOOTSTRAP__.shareSnapshot)) : null;
      result.initialId = (await state(page)).selectedId;
      assert.equal(result.initialId, entry.shared ? "2" : "1");
      if (entry.view) await page.evaluate(({ latitude, longitude, zoom }) => {
        window.__pagesProbe.map().setView([latitude, longitude], zoom, { animate: false });
      }, entry.view);
      if (!entry.shared) assert.equal(await select(page, "2"), true);
      await vectorReady(page);
      result.vector = await state(page);
      checkVector(result.vector);
      if (entry.view) assert.equal(result.vector.zoom, entry.view.zoom);
      await page.screenshot({ path: resolve(evidence, `${entry.name}-vector.png`) });
      if (entry.print) result.print = await printPdf(page, result);
      assert.equal(await select(page, "3"), false);
      assert.equal((await state(page)).selectedId, "2", "Failed selection must retain the real vector background");
      await page.locator('dialog[open] button').filter({ hasText: /閉じる|OK/ }).first().click().catch(() => {});
      assert.equal(await select(page, "1"), true);
      const raster = await state(page);
      assert.equal(raster.selectedId, "1");
      assert.equal(raster.canvasCount, 0);
      assert.deepEqual(raster.checkedIds, ["1"]);
      result.rasterRestored = true;
      if (entry.shared) assert.equal(await page.evaluate(() => JSON.stringify(window.__GEOCODE_MAP_BOOTSTRAP__.shareSnapshot)), snapshotBefore, "Archived v2 background must remain unchanged");
      assert(result.network.some(response => response.url === safeUrl(provider.styleUrl) && response.status === 200), "The provider style must be fetched directly");
      const glyph = url => /\/(?:fonts|glyphs|noto-jp)\//.test(url);
      assert(result.network.some(response => /\.pbf$/.test(response.url) && !glyph(response.url) && response.status === 200), "The real provider must supply vector tile PBF data");
      // 広域の一部ラベルは、端末内の漢字フォントだけで描画される。
      if (!entry.view) assert(result.network.some(response => glyph(response.url) && /\.pbf$/.test(response.url) && response.status === 200), "The real provider must supply glyph PBF data");
      for (const extension of [".json", ".png"])
        assert(result.network.some(response => /\/sprites?\//.test(response.url) && response.url.endsWith(extension) && response.status === 200), `The real provider must supply sprite ${extension}`);
      assert.deepEqual(result.pageErrors, []);
      assert.deepEqual(result.httpFailures, []);
      assert.deepEqual(result.networkFailures, []);
      assert.deepEqual(result.unexpectedOrigins, []);
      assert.deepEqual(await page.evaluate(() => window.__providerViolations), []);
      assert(result.workers.length > 0 && result.workers.every(url => url.startsWith(`${server.url}/assets/template-maplibre-gl-worker-`)));
      result.passed = true;
      console.log(`${provider.id}/${entry.name}: passed`);
    } catch (error) {
      result.error = String(error);
      result.state = await state(page).catch(() => null);
      const printFrame = page.frames().find(frame => /\/assets\/read-only-map-print\.html/.test(frame.url()));
      if (printFrame) result.failedPrintState = await printDiagnostics(printFrame).catch(() => null);
      await page.screenshot({ path: resolve(evidence, `${entry.name}-failure.png`), timeout: 5000 }).catch(() => {});
      console.log(`${provider.id}/${entry.name}: FAILED ${String(error)}`);
    } finally {
      result.canceledRequests = canceled;
      closing = true;
      await context.close();
    }
  }
} finally {
  const browserVersion = browser?.version();
  await browser?.close();
  await writeFile(report, JSON.stringify({ timestamp: new Date().toISOString(), browserVersion, provider, policy: server.policy,
    methodology: "Production built map entries with live public provider resources and local synthetic application APIs; no application DB, registration, deployment, or real mobile device. One viewport per case; no area downloads. Native print is observed with a stub; the PDF is saved through the production exporter and requires Poppler visual inspection.", results }, null, 2));
  await server.close();
}
assert(results.length === cases.length && results.every(result => result.passed), `Provider acceptance failed; see ${report}`);
