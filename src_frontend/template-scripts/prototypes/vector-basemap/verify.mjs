import assert from "node:assert/strict";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { createPrototypeServer } from "./serve.mjs";
import { buildPrototype, outputDirectory } from "./build.mjs";

const evidence = resolve(outputDirectory, "../evidence");
await mkdir(evidence, { recursive: true });
await buildPrototype();
const server = await createPrototypeServer({ root: outputDirectory });
const results = [];
let browser;
try {
  browser = await chromium.launch({
    channel: "chrome", headless: true,
    args: ["--enable-unsafe-swiftshader"],
  });
  for (const [name, viewport, mobile] of [
    ["desktop", { width: 1440, height: 1000 }, false],
    ["mobile", { width: 430, height: 932 }, true],
  ]) {
    const context = await browser.newContext({ viewport, isMobile: mobile, hasTouch: mobile, acceptDownloads: true });
    const page = await context.newPage();
    page.setDefaultTimeout(30000);
    const errors = [], external = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) => {
      if (!request.url().startsWith(server.url) && /^https?:/.test(request.url())) external.push(request.url());
    });
    const result = { name, viewport, passed: false };
    results.push(result);
    try {
      await page.addInitScript(() => localStorage.setItem("geocode-web:selected-tile-server-id", "1"));
      await page.goto(server.url, { waitUntil: "networkidle" });
      await page.waitForFunction(() => Boolean(window.prototype));
      await page.waitForFunction(() => !document.querySelector("#pdf-export")?.disabled);
      assert.deepEqual(await page.evaluate(() => window.prototype.compatibility()), {
        v1: true, printV1: true, unchangedSnapshot: true, unchangedStorage: true, sharedLeaflet: true,
      });
      await page.screenshot({ path: resolve(evidence, `${name}-raster.png`) });
      console.log(`${name}: raster and v1 compatibility passed`);

      assert.equal(await page.evaluate(() => window.prototype.selectVector()), true);
      await page.waitForFunction(() => {
        const state = window.prototype.getState();
        return state.selected === "vector" && !state.pending && !state.print.loading && !state.print.failed;
      });
      await page.waitForFunction(() => !document.querySelector("#pdf-export")?.disabled);
      await page.locator("#print-size").selectOption("a3-portrait");
      await page.waitForFunction(() => !document.querySelector("#pdf-export")?.disabled);
      await page.locator("#print-size").selectOption("a4-landscape");
      await page.waitForFunction(() => !document.querySelector("#pdf-export")?.disabled);
      const features = await page.evaluate(() => window.prototype.getFeatures());
      assert(features.some((feature) => feature.properties.name === "東京"), "Tokyo label must render from MVT");
      assert(features.some((feature) => feature.properties.name === "公園"), "Park label must render from MVT");
      assert(features.some((feature) => feature.properties.kind === "facility"), "Sprite symbol must render");
      assert.equal(await page.evaluate(() => window.prototype.marker.getElement().isConnected), true);
      result.features = [...new Set(features.map((feature) => feature.layer))];
      result.webgl = await page.evaluate(() => {
        const gl = document.querySelector("canvas[data-geocode-maplibre-canvas]").getContext("webgl2");
        const debug = gl.getExtension("WEBGL_debug_renderer_info");
        return { version: gl.getParameter(gl.VERSION), renderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER) };
      });
      await page.screenshot({ path: resolve(evidence, `${name}-vector.png`) });
      await page.locator("#map").screenshot({ path: resolve(evidence, `${name}-map.png`) });
      console.log(`${name}: MVT, glyphs, sprite and Leaflet overlay rendered`);

      // 既存のPDF操作から、実際のhtml2canvas/jsPDFを経由したダウンロードを検証する。
      await page.locator("#pdf-export").click();
      await page.waitForFunction(() => document.querySelector(".pdf-output [data-status]")?.textContent === "PDFを作成しました。", { timeout: 60000 });
      const downloadPromise = page.waitForEvent("download");
      await page.locator(".pdf-output [data-save]").click();
      const download = await downloadPromise;
      const pdfPath = resolve(evidence, `${name}-vector-export.pdf`);
      await download.saveAs(pdfPath);
      const pdf = await readFile(pdfPath);
      assert.equal(pdf.subarray(0, 4).toString(), "%PDF");
      assert(pdf.length > 20000, "PDF must include the rendered map image");
      result.exportBytes = pdf.length;

      // 本体の印刷ボタンがwindow.printの前にcanvasを準備し、印刷後に復元することを確認する。
      await page.evaluate(() => {
        window.print = () => { window.printImageSeen = Boolean(document.querySelector("[data-geocode-maplibre-print-image]")); };
      });
      await page.waitForFunction(() => !document.querySelector("#print-submit")?.disabled);
      await page.locator("#print-submit").click();
      await page.waitForFunction(() => window.printImageSeen === true);
      await page.waitForFunction(() => !document.querySelector("[data-geocode-maplibre-print-image]"));

      // Chromiumの印刷処理では、アプリケーションの実際の印刷用スタイルを適用する。
      await page.evaluate(() => window.prototype.preparePrint());
      await page.pdf({ path: resolve(evidence, `${name}-vector-browser-print.pdf`), preferCSSPageSize: true, printBackground: true });
      await page.evaluate(() => window.prototype.restorePrint());
      console.log(`${name}: existing PDF exporter and browser print passed`);

      // 候補の読み込みに失敗した場合は、確定済みで表示中の背景を保持する。
      assert.equal(await page.evaluate(() => window.prototype.selectVector("/fixtures/missing-style.json", 5000)), false);
      assert.equal(await page.evaluate(() => window.prototype.getState().selected), "vector");
      assert.equal(await page.locator("canvas[data-geocode-maplibre-canvas]").count(), 1);

      // 競合する非同期切替でも、後から選択したラスタ背景を維持する。
      const staleResult = await page.evaluate(async () => {
        const request = window.prototype.selectVector();
        window.prototype.selectRaster();
        return request;
      });
      assert.equal(staleResult, false);
      await page.waitForFunction(() => !document.querySelector("#pdf-export")?.disabled);
      assert.equal(await page.locator("canvas[data-geocode-maplibre-canvas]").count(), 0);
      assert.equal(await page.evaluate(() => window.prototype.getState().selected), "raster");
      assert(Object.values(await page.evaluate(() => window.prototype.compatibility())).every(Boolean));
      assert.deepEqual(await page.evaluate(() => window.prototype.getState().violations), []);
      assert.deepEqual(errors, []);
      assert.deepEqual(external, []);
      result.passed = true;
      result.checks = ["legacy raster", "v1 share and print snapshot", "same Leaflet instance", "MVT", "Japanese glyphs", "sprite", "Leaflet overlays", "paper resize", "PDF exporter", "browser print", "failed switch", "switch race", "CSP", "storage unchanged"];
    } catch (error) {
      result.error = String(error);
      result.pageErrors = errors;
      await page.screenshot({ path: resolve(evidence, `${name}-failure.png`) }).catch(() => {});
    } finally {
      await context.close();
    }
  }
  for (const resource of [/\/fixtures\/tiles\/.*\.pbf$/, /\/fixtures\/fonts\/.*\.pbf$/, /\/fixtures\/sprite\.png$/, /\/fixtures\/sprite\.json$/, /maplibre-gl-worker.*\.js$/]) {
    assert(server.requests.some((request) => request.status === 200 && resource.test(request.path)), `Expected successful resource: ${resource}`);
  }
  const unavailableContext = await browser.newContext();
  const unavailableResult = { name: "WebGL unavailable", passed: false };
  results.push(unavailableResult);
  try {
    const page = await unavailableContext.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript(() => {
      const original = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (kind, ...args) {
        if (String(kind).startsWith("webgl")) return null;
        return original.call(this, kind, ...args);
      };
    });
    await page.goto(server.url, { waitUntil: "networkidle" });
    await page.waitForFunction(() => Boolean(window.prototype));
    assert.equal(await page.evaluate(() => window.prototype.selectVector()), false);
    assert.equal(await page.evaluate(() => window.prototype.getState().selected), "raster");
    assert.equal(await page.locator("canvas[data-geocode-maplibre-canvas]").count(), 0);
    assert.deepEqual(errors, []);
    unavailableResult.passed = true;
    unavailableResult.checks = ["raster retained", "no unhandled errors"];
    console.log("WebGL unavailable: raster fallback passed");
  } catch (error) {
    unavailableResult.error = String(error);
  } finally {
    await unavailableContext.close();
  }
  const legacyContext = await browser.newContext();
  const legacyResult = { name: "archived v1 share replay", passed: false };
  results.push(legacyResult);
  try {
    const page = await legacyContext.newPage();
    await page.addInitScript(() => {
      localStorage.setItem("geocode-web:selected-tile-server-id", "999");
      localStorage.setItem("geocode-web:last-map-view", JSON.stringify({ latitude: 1, longitude: 2, zoom: 3 }));
    });
    await page.goto(`${server.url}/?legacy-share=1`, { waitUntil: "networkidle" });
    await page.waitForFunction(() => Boolean(window.prototype) && !document.querySelector("#pdf-export")?.disabled);
    assert.equal(await page.evaluate(() => window.prototype.getState().selected), "raster");
    assert.equal(await page.evaluate(() => window.prototype.map.getZoom()), 14);
    assert(Object.values(await page.evaluate(() => window.prototype.compatibility())).every(Boolean));
    legacyResult.passed = true;
    legacyResult.checks = ["existing temporary-map snapshot renderer", "stored view overrides local preferences", "v1 raster retained"];
    console.log("Archived v1 share: actual snapshot print path passed");
  } catch (error) {
    legacyResult.error = String(error);
  } finally {
    await legacyContext.close();
  }
} finally {
  await browser?.close();
  await server.close();
  await writeFile(resolve(evidence, "results.json"), JSON.stringify({ results, requests: server.requests }, null, 2));
  console.log(JSON.stringify(results, null, 2));
}
if (results.some((result) => !result.passed)) process.exitCode = 1;
