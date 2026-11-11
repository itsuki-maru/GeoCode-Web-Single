import assert from "node:assert/strict";
import { writeFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { createPrototypeServer, prototypeContentSecurityPolicy } from "./serve.mjs";
import { fixtureCenter } from "./fixtures.mjs";
import { buildPagesFixture, pagesOutputDirectory, pagesEvidenceDirectory, markers } from "./pages-fixture.mjs";

const cases = await buildPagesFixture();
const server = await createPrototypeServer({ root: pagesOutputDirectory });
const results = [];
let browser;
const selectedNames = process.env.VECTOR_PAGE_ENTRIES?.split(",");
const webglDisabled = process.env.VECTOR_WEBGL_DISABLED === "1";
const selectedCases = cases.filter((entry) => (!selectedNames || selectedNames.includes(entry.name)) &&
  (webglDisabled
    ? (entry.name === "map" && entry.variant === "default") || (entry.name === "temporary-map" && entry.variant === "v2")
    : entry.variant === "default" || entry.name.startsWith("temporary-map")));

async function waitForController(page) {
  await page.waitForFunction(() => Boolean(window.__pagesProbe?.controller()));
  await page.evaluate(() => window.__pagesProbe.controller().whenReady());
}
async function getVectorState(page) {
  return page.evaluate(() => {
    const gl = window.__pagesProbe.gl();
    return {
      selectedId: window.__pagesProbe.controller().getSelectedId(),
      pending: window.__pagesProbe.controller().isPending(),
      canvasCount: document.querySelectorAll("canvas[data-geocode-maplibre-canvas]").length,
      center: window.__pagesProbe.map().getCenter(), zoom: window.__pagesProbe.map().getZoom(),
      featureLayers: gl ? [...new Set(gl.queryRenderedFeatures().map(feature => feature.layer.id))] : [],
      sourceLayers: gl ? [...new Set(gl.querySourceFeatures("fixture", { sourceLayer: "basemap" }).map(feature => feature.properties.kind))] : [],
      singleLeafletInstance: !gl || Object.values(window.__pagesProbe.map()._layers).filter(layer => layer.getMaplibreMap).every(layer => layer instanceof L.Layer),
      violations: window.__pagesViolations,
    };
  });
}
async function select(page, id) {
  const result = await page.evaluate(id => window.__pagesProbe.controller().select(id), id);
  await page.evaluate(() => window.__pagesProbe.controller().whenReady());
  return result;
}
async function installApiRoutes(context) {
  await context.route("**/live-api/maps/*/positions", route => route.fulfill({
    contentType: "application/json", body: JSON.stringify({
      map: { id: "00000000-0000-0000-0000-000000000001", name: "Production entry fixture" }, server_time: "2026-11-11T00:00:00Z", positions: [], refresh_after_ms: 60000,
    }),
  }));
  await context.route("**/marker/read/all?*", route => route.fulfill({ contentType: "application/json", body: JSON.stringify(markers) }));
  await context.route("**/shapes?*", route => route.fulfill({ contentType: "application/json", body: "[]" }));
  await context.route("**/favicon.ico", route => route.fulfill({ status: 204 }));
  await context.route("**/apple-touch-icon-*.png", route => route.fulfill({ status: 204 }));
}

try {
  browser = await chromium.launch({ channel: "chrome", headless: true,
    args: webglDisabled ? ["--disable-webgl"] : ["--enable-unsafe-swiftshader"],
  });
  for (const entry of selectedCases) {
    const mobile = entry.name.includes("mobile");
    const context = await browser.newContext({
      viewport: mobile ? { width: 430, height: 932 } : { width: 1440, height: 1000 },
      isMobile: mobile, hasTouch: mobile, acceptDownloads: true,
    });
    await installApiRoutes(context);
    const page = await context.newPage();
    page.setDefaultTimeout(35000);
    const errors = [], external = [], workers = [];
    page.on("pageerror", error => errors.push({ name: error.name, message: error.message, stack: error.stack }));
    page.on("worker", worker => workers.push(worker.url()));
    page.on("request", request => {
      if (/^https?:/.test(request.url()) && !request.url().startsWith(server.url)) external.push(request.url());
    });
    const result = { ...entry, passed: false };
    results.push(result);
    try {
      const response = await page.goto(`${server.url}${entry.path}`, { waitUntil: "networkidle" });
      assert.equal(response.headers()["content-security-policy"], prototypeContentSecurityPolicy);
      await waitForController(page);
      const initialId = await page.evaluate(() => window.__pagesProbe.controller().getSelectedId());
      assert.equal(initialId, entry.variant === "v2" && !webglDisabled ? "2" : "1");
      result.initialId = initialId;
      if (webglDisabled) {
        assert.equal(await page.evaluate(() => Boolean(document.createElement("canvas").getContext("webgl2"))), false);
        if (entry.variant !== "v2") assert.equal(await select(page, "2"), false);
        const state = await getVectorState(page);
        assert.equal(state.selectedId, "1");
        assert.equal(state.pending, false);
        assert.equal(state.canvasCount, 0);
        assert.equal(await page.evaluate(() => Number.isFinite(window.__pagesProbe.map().getMaxZoom())), true);
        result.checks = ["WebGL disabled", entry.variant === "v2" ? "saved v2 fallback" : "raster preserved", "failed candidate disposed"];
      } else if (entry.variant === "legacy") {
        assert.equal((await getVectorState(page)).canvasCount, 0);
        assert.equal(await page.evaluate(() => Object.hasOwn(window.__GEOCODE_MAP_BOOTSTRAP__.shareSnapshot.tileServers["1"], "kind")), false);
        result.checks = ["archived v1 snapshot", "legacy raster definition", "unchanged selected ID"];
      } else {
        await page.evaluate(center => window.__pagesProbe.map().setView(center, 14, { animate: false }), fixtureCenter);
        if (initialId !== "2") {
          await page.locator('.tile-radio[value="2"]').first().click({ force: true });
          await page.waitForFunction(() => window.__pagesProbe.controller().getSelectedId() === "2" && !window.__pagesProbe.controller().isPending());
        }
        await page.waitForFunction(() => Boolean(window.__pagesProbe.gl()?.loaded()) && window.__pagesProbe.gl().areTilesLoaded());
        const vector = await getVectorState(page);
        assert.equal(vector.canvasCount, 1);
        assert.equal(vector.singleLeafletInstance, true);
        assert(vector.featureLayers.includes("roads"), "MVT road features were not rendered");
        assert(vector.featureLayers.includes("labels"), "Japanese glyph labels were not rendered");
        assert(vector.featureLayers.includes("facility"), "Sprite icon was not rendered");
        assert(vector.sourceLayers.includes("park"));
        const attribution = await page.locator(".leaflet-control-attribution").innerText();
        assert(attribution.includes("Vector background fixture"), "Committed vector attribution is missing");
        assert(!attribution.includes("Legacy raster fixture"), "Previous raster attribution was not removed");
        result.attribution = attribution;
        await page.screenshot({ path: resolve(pagesEvidenceDirectory, `${entry.name}-${entry.variant}-vector.png`) });
        result.vector = vector;
        assert.equal(await select(page, "3"), false);
        assert.equal((await getVectorState(page)).selectedId, "2");
        assert.equal((await getVectorState(page)).canvasCount, 1);
        // このモーダルは、本体ページが意図どおりに表示したエラー通知。
        await page.locator('dialog[open] button').filter({ hasText: /閉じる|OK/ }).first().click().catch(() => {});
        await page.locator('.tile-radio[value="1"]').first().click({ force: true });
        await page.waitForFunction(() => window.__pagesProbe.controller().getSelectedId() === "1" && !window.__pagesProbe.controller().isPending());
        // 実際のスタイル応答を保留し、Bへの切替中に選択済みのAを再クリックする。
        // この操作はchangeだけを監視するリスナーでは検出できない。
        let releaseStyle;
        let finishStyle;
        let interceptStyle;
        const styleGate = new Promise(resolve => { releaseStyle = resolve; });
        const styleFinished = new Promise(resolve => { finishStyle = resolve; });
        const styleIntercepted = new Promise(resolve => { interceptStyle = resolve; });
        const stylePattern = "**/fixtures/style.json";
        const holdStyle = async route => {
          try {
            interceptStyle();
            await styleGate;
            await route.continue().catch(() => {});
          } finally {
            finishStyle();
          }
        };
        await page.route(stylePattern, holdStyle);
        try {
          const request = page.waitForRequest(request => new URL(request.url()).pathname === "/fixtures/style.json");
          await page.locator('.tile-radio[value="2"]').first().click({ force: true });
          await request;
            await styleIntercepted;
          await page.waitForFunction(() => window.__pagesProbe.controller().isPending());
          assert.equal(await page.locator('.tile-radio[value="1"]').first().isChecked(), true);
          await page.locator('.tile-radio[value="1"]').first().click({ force: true });
          await page.waitForFunction(() => !window.__pagesProbe.controller().isPending());
          assert.equal((await getVectorState(page)).selectedId, "1");
          releaseStyle();
          await styleFinished;
        } finally {
          releaseStyle();
          await page.unroute(stylePattern, holdStyle);
        }
        assert.equal((await getVectorState(page)).selectedId, "1");
        assert.equal((await getVectorState(page)).canvasCount, 0);
        assert.equal(await select(page, "2"), true);
        result.checks = ["production entry", "legacy raster", "vector selection", "MVT features", "Japanese glyphs", "sprite", "same Leaflet instance", "failed selection retained", "radio B to checked A cancellation"];

        if (entry.name === "map-anather" && entry.variant === "default") {
          console.log("map-anather: checking Leaflet marker");
          await page.getByRole("checkbox", { name: "Fixture objects", exact: true }).check({ force: true });
          console.log("map-anather: marker layer checked");
          await page.waitForFunction(() => {
            let markerVisible = false;
            window.__pagesProbe.map().eachLayer(layer => {
              if (layer instanceof L.Marker) {
                const point = layer.getLatLng();
                if (Math.abs(point.lat - 35.679) < 0.00001 && Math.abs(point.lng - 139.755) < 0.00001)
                  markerVisible = Boolean(layer.getElement()?.getBoundingClientRect().width);
              }
            });
            return markerVisible;
          });
          result.leafletMarkerVisible = true;
          console.log("map-anather: opening production print dialog");
          await page.getByRole("button", { name: "地図を印刷", exact: true }).click();
          const frameLocator = page.frameLocator('dialog.map-print-host iframe');
          await frameLocator.locator("#pdf-export").waitFor();
          console.log("map-anather: waiting for print readiness");
          await frameLocator.locator("#pdf-export").isEnabled();
          await page.waitForFunction(() => {
            const frame = document.querySelector('dialog.map-print-host iframe');
            return frame?.contentDocument?.querySelector('#pdf-export')?.disabled === false;
          });
          await frameLocator.locator(".leaflet-marker-icon").first().waitFor({ state: "visible" });
          console.log("map-anather: exporting PDF with marker");
          result.printMarkerCount = await frameLocator.locator(".leaflet-marker-icon").count();
          await frameLocator.locator("#pdf-export").click();
          await frameLocator.locator('.pdf-output [data-status]').filter({ hasText: "PDFを作成しました。" }).waitFor({ timeout: 60000 });
          const downloadPromise = page.waitForEvent("download");
          await frameLocator.locator("[data-save]").click();
          const download = await downloadPromise;
          const path = resolve(pagesEvidenceDirectory, "production-map-anather-vector.pdf");
          await download.saveAs(path);
          const pdf = await readFile(path);
          assert.equal(pdf.subarray(0, 4).toString(), "%PDF");
          assert(pdf.length > 20000, "PDF output must contain the rendered map image");
          result.pdfBytes = pdf.length;
          await page.screenshot({ path: resolve(pagesEvidenceDirectory, "production-print-preview.png") });
          result.checks.push("existing Leaflet marker", "marker in print iframe", "real print dialog", "production PDF exporter");
        }
      }
      assert.deepEqual(errors, []);
      assert.deepEqual(external, []);
      assert.deepEqual(await page.evaluate(() => window.__pagesViolations), []);
      assert(workers.every(url => url.startsWith(server.url)), "Workers must be served from the same origin");
      result.workers = workers;
      result.passed = true;
      console.log(`${entry.name}/${entry.variant}: passed`);
    } catch (error) {
      result.error = String(error);
      result.pageErrors = errors;
      result.external = external;
      result.workers = workers;
      result.state = await getVectorState(page).catch(() => null);
      await page.screenshot({ path: resolve(pagesEvidenceDirectory, `${entry.name}-${entry.variant}-failure.png`) }).catch(() => {});
      console.log(`${entry.name}/${entry.variant}: FAILED ${String(error)}`);
    } finally {
      await context.close();
    }
  }
} finally {
  await browser?.close();
  const report = { timestamp: new Date().toISOString(), webglDisabled, policy: prototypeContentSecurityPolicy, results, requests: server.requests };
  await writeFile(resolve(pagesEvidenceDirectory, webglDisabled ? "results-webgl-disabled.json" : "results.json"), JSON.stringify(report, null, 2));
  await server.close();
}
assert(results.length > 0 && results.every(result => result.passed), "Production page verification failed; see target/vector-basemap-pages/evidence/results.json");
