// `npm --prefix src_frontend/template-scripts run build`の後に実行する。
// 本体の入口と検証用データで検証する。アプリケーションとDBの起動は不要。
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { assertStableLifecycle } from "./lifecycle-assertions.mjs";
import { fixtureCenter } from "./fixtures.mjs";
import { buildPagesFixture, pagesOutputDirectory, repository, markers } from "./pages-fixture.mjs";
import { createPrototypeServer, prototypeContentSecurityPolicy } from "./serve.mjs";

const cycles = Number(process.argv.find(arg => arg.startsWith("--cycles="))?.slice("--cycles=".length) ?? 20);
assert(Number.isInteger(cycles) && cycles >= 1 && cycles <= 100, "--cycles must be an integer from 1 to 100");
const evidence = resolve(repository, "target/vector-basemap-lifecycle/evidence");
await mkdir(evidence, { recursive: true });
const cases = await buildPagesFixture();
const server = await createPrototypeServer({ root: pagesOutputDirectory });
const results = [];
let browser;

async function bounded(promise, label, timeout = 40000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error(`${label} did not finish`)), timeout);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

async function eventually(check, label, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise(resolveWait => setTimeout(resolveWait, 25));
  }
  throw Error(`${label} did not settle`);
}

function observeWorkers(page) {
  const alive = new Set();
  const urls = [];
  let closed = 0;
  let peak = 0;
  page.on("worker", worker => {
    alive.add(worker);
    urls.push(worker.url());
    peak = Math.max(peak, alive.size);
    worker.once("close", () => { if (alive.delete(worker)) closed += 1; });
  });
  return { stats: () => ({ created: urls.length, closed, live: alive.size, peak }), urls };
}

async function installInstrumentation(page) {
  await page.evaluate(() => {
    const records = [];
    const observed = new WeakSet();
    let removalEvents = 0;
    const observe = layer => {
      if (typeof layer.getMaplibreMap !== "function") return;
      const gl = layer.getMaplibreMap();
      if (!gl || observed.has(gl)) return;
      observed.add(gl);
      const canvas = gl.getCanvas();
      const context = canvas.getContext("webgl2");
      const loseExtension = context?.getExtension("WEBGL_lose_context");
      const entry = { gl, canvas, context, loseExtension, removed: false };
      records.push(entry);
      gl.once("remove", () => { entry.removed = true; removalEvents += 1; });
    };
    const map = window.__pagesProbe.map();
    const controller = window.__pagesProbe.controller();
    map.eachLayer(observe);
    map.on("layeradd", event => observe(event.layer));
    window.__lifecycleProbe = {
      records,
      read() {
        const layers = Object.values(map._layers);
        const removed = records.filter(record => record.removed && record.gl._removed === true);
        return {
          selectedId: controller.getSelectedId(),
          checkedIds: [...document.querySelectorAll(".tile-radio:checked")].map(radio => radio.value),
          pending: controller.isPending(),
          layerCount: layers.length,
          bridgeCount: layers.filter(layer => typeof layer.getMaplibreMap === "function").length,
          canvasCount: document.querySelectorAll("canvas[data-geocode-maplibre-canvas]").length,
          glMapsCreated: records.length,
          removedMaps: removed.length,
          removalEvents,
          liveGLMaps: records.length - removed.length,
          connectedRemovedCanvases: removed.filter(record => record.canvas.isConnected).length,
          unreleasedRemovedContexts: removed.filter(record => record.loseExtension && !record.context.isContextLost()).length,
          savedPreference: localStorage.getItem("geocode-web:selected-tile-server-id"),
          zoom: map.getZoom(), center: map.getCenter(),
        };
      },
      loseActiveContext() {
        const active = records.find(record => !record.removed);
        if (!active?.loseExtension) return false;
        active.loseExtension.loseContext();
        return true;
      },
    };
  });
}

async function state(page, workers) {
  return { ...await bounded(page.evaluate(() => window.__lifecycleProbe.read()), "Reading lifecycle state", 10000), workers: workers.stats() };
}

async function select(page, id) {
  return bounded(page.evaluate(async id => {
    const result = await window.__pagesProbe.controller().select(id);
    await window.__pagesProbe.controller().whenReady();
    return result;
  }, id), `Selecting background ${id}`);
}

async function waitForVector(page) {
  await page.waitForFunction(() => {
    const gl = window.__pagesProbe.gl();
    return gl?.loaded() && gl.areTilesLoaded();
  }, undefined, { timeout: 35000 });
}

async function dismissError(page) {
  const close = page.locator("dialog.map-message-dialog[open]").getByRole("button", { name: "閉じる", exact: true });
  if (await close.count()) await close.click();
}

async function capturedShare(page, expectedId) {
  const before = await page.evaluate(() => window.__lifecycleShares.length);
  await page.getByRole("button", { name: "現在の地図を共有する", exact: true }).click();
  await page.waitForFunction(before => window.__lifecycleShares.length > before, before, { timeout: 10000 });
  const snapshot = await page.evaluate(() => window.__lifecycleShares.at(-1));
  assert.equal(snapshot.state.tileServerId, expectedId, "Actual share snapshot must use the committed background");
  assert.equal(snapshot.version, 2, "The stored list contains vector metadata even when raster is selected");
  assert.equal(snapshot.tileServers["2"].style_url, "/fixtures/style.json");
  return { id: snapshot.state.tileServerId, version: snapshot.version };
}

async function cancelPendingByRadio(page) {
  let release;
  let intercepted;
  const gate = new Promise(resolveGate => { release = resolveGate; });
  const started = new Promise(resolveStarted => { intercepted = resolveStarted; });
  const pattern = "**/fixtures/style.json";
  const hold = async route => {
    intercepted();
    await gate;
    await route.continue().catch(() => {});
  };
  await page.route(pattern, hold);
  try {
    await page.locator('.tile-radio[value="2"]').first().click({ force: true });
    await bounded(started, "Intercepting pending vector style", 10000);
    await page.waitForFunction(() => window.__pagesProbe.controller().isPending());
    assert.equal(await page.locator('.tile-radio[value="1"]').first().isChecked(), true);
    await page.locator('.tile-radio[value="1"]').first().click({ force: true });
    await page.waitForFunction(() => !window.__pagesProbe.controller().isPending());
  } finally {
    release();
    await page.unroute(pattern, hold);
  }
}

try {
  browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--enable-unsafe-swiftshader"] });
  for (const entry of [
    { name: "desktop", page: "map-anather", viewport: { width: 1440, height: 1000 }, mobile: false },
    { name: "mobile", page: "map-mobile", viewport: { width: 430, height: 932 }, mobile: true },
  ]) {
    const fixture = cases.find(item => item.name === entry.page && item.variant === "default");
    assert(fixture);
    const context = await browser.newContext({ viewport: entry.viewport, isMobile: entry.mobile, hasTouch: entry.mobile });
    await context.route("**/marker/read/all?*", route => route.fulfill({ contentType: "application/json", body: JSON.stringify(markers) }));
    await context.route("**/shapes?*", route => route.fulfill({ contentType: "application/json", body: "[]" }));
    await context.route("**/favicon.ico", route => route.fulfill({ status: 204 }));
    await context.route("**/apple-touch-icon-*.png", route => route.fulfill({ status: 204 }));
    await context.addInitScript(() => {
      window.__lifecycleShares = [];
      window.addEventListener("message", event => {
        if (event.source === window && event.origin === location.origin && event.data?.type === "shareMapSnapshot")
          window.__lifecycleShares.push(event.data.snapshot);
      });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(35000);
    const workers = observeWorkers(page);
    const errors = [], external = [];
    const result = { ...entry, cycles, passed: false, samples: [], shares: [] };
    results.push(result);
    page.on("pageerror", error => errors.push({ message: error.message, stack: error.stack }));
    page.on("request", request => { if (/^https?:/.test(request.url()) && !request.url().startsWith(server.url)) external.push(request.url()); });
    try {
      const response = await page.goto(`${server.url}${fixture.path}`, { waitUntil: "networkidle" });
      assert.equal(response.headers()["content-security-policy"], prototypeContentSecurityPolicy);
      await page.waitForFunction(() => Boolean(window.__pagesProbe?.controller()));
      await page.evaluate(center => window.__pagesProbe.map().setView(center, 14, { animate: false }), fixtureCenter);
      await page.evaluate(() => window.__pagesProbe.controller().whenReady());
      await installInstrumentation(page);
      const baseline = await state(page, workers);
      assertStableLifecycle(baseline, { id: "1", layers: baseline.layerCount, workers: 0 });
      result.baselineLayers = baseline.layerCount;
      let activeWorkers;
      for (let cycle = 1; cycle <= cycles; cycle += 1) {
        assert.equal(await select(page, "2"), true);
        await waitForVector(page);
        await page.evaluate(({ center, cycle }) => {
          window.__pagesProbe.map().setView([center[0] + (cycle % 2 ? 0.0002 : -0.0002), center[1]], cycle % 2 ? 15 : 14, { animate: false });
        }, { center: fixtureCenter, cycle });
        await waitForVector(page);
        await eventually(() => workers.stats().live > 0, "Creating the active Worker pool");
        const active = await state(page, workers);
        activeWorkers ??= active.workers.live;
        assertStableLifecycle(active, { id: "2", layers: baseline.layerCount + 1, workers: activeWorkers });
        if (entry.mobile) assert.equal(active.savedPreference, "2");
        if (!entry.mobile && (cycle === 1 || cycle === cycles)) result.shares.push(await capturedShare(page, "2"));
        assert.equal(await select(page, "1"), true);
        await eventually(async () => {
          const raster = await state(page, workers);
          return raster.workers.live === 0 && raster.unreleasedRemovedContexts === 0;
        }, "Releasing the previous vector's Workers and WebGL context");
        const raster = await state(page, workers);
        assertStableLifecycle(raster, { id: "1", layers: baseline.layerCount, workers: 0 });
        if (entry.mobile) assert.equal(raster.savedPreference, "1");
        result.samples.push({ cycle, vector: active, raster });
        if (cycle % 5 === 0 || cycle === cycles) console.log(`${entry.name}: ${cycle}/${cycles} cycles; ${raster.workers.created} Workers created, ${raster.workers.live} live`);
      }

      await cancelPendingByRadio(page);
      await eventually(() => workers.stats().live === 0, "Releasing the cancelled candidate's Workers");
      const cancelled = await state(page, workers);
      assertStableLifecycle(cancelled, { id: "1", layers: baseline.layerCount, workers: 0 });
      result.cancelled = cancelled;
      if (!entry.mobile) result.shares.push(await capturedShare(page, "1"));

      assert.equal(await select(page, "2"), true);
      await waitForVector(page);
      assert.equal(await select(page, "3"), false);
      await eventually(() => workers.stats().live === activeWorkers, "Releasing the failed candidate's Worker claim");
      const failed = await state(page, workers);
      assertStableLifecycle(failed, { id: "2", layers: baseline.layerCount + 1, workers: activeWorkers });
      result.failedSelection = failed;
      await dismissError(page);
      if (!entry.mobile) result.shares.push(await capturedShare(page, "2"));

      assert.equal(await page.evaluate(() => window.__lifecycleProbe.loseActiveContext()), true, "Chrome must expose WEBGL_lose_context for the failure test");
      await page.waitForFunction(() => window.__pagesProbe.controller().getSelectedId() === "1" && !window.__pagesProbe.controller().isPending());
      await eventually(() => workers.stats().live === 0, "Releasing resources after WebGL context loss");
      const contextLost = await state(page, workers);
      assertStableLifecycle(contextLost, { id: "1", layers: baseline.layerCount, workers: 0 });
      if (entry.mobile) assert.equal(contextLost.savedPreference, "2", "Automatic fallback must preserve the user's vector preference");
      result.contextLost = contextLost;
      await dismissError(page);
      if (!entry.mobile) result.shares.push(await capturedShare(page, "1"));

      assert.equal(await select(page, "2"), true);
      await waitForVector(page);
      await page.evaluate(() => window.__pagesProbe.controller().dispose());
      await eventually(() => workers.stats().live === 0, "Releasing resources on controller disposal");
      const disposed = await state(page, workers);
      assert.equal(disposed.layerCount, baseline.layerCount - 1);
      assert.equal(disposed.bridgeCount, 0);
      assert.equal(disposed.canvasCount, 0);
      assert.equal(disposed.liveGLMaps, 0);
      assert.equal(disposed.connectedRemovedCanvases, 0);
      assert.equal(disposed.unreleasedRemovedContexts, 0);
      assert.equal(disposed.removalEvents, disposed.glMapsCreated);
      assert.equal(disposed.workers.live, 0);
      result.disposed = disposed;
      assert.deepEqual(errors, []);
      assert.deepEqual(external, []);
      assert.deepEqual(await page.evaluate(() => window.__pagesViolations), []);
      assert(workers.urls.every(url => url.startsWith(`${server.url}/assets/template-maplibre-gl-worker-`)), "Every Worker must use the same-origin emitted asset");
      result.workers = workers.stats();
      result.passed = true;
      console.log(`${entry.name}: passed`);
    } catch (error) {
      result.error = String(error);
      result.errors = errors;
      result.external = external;
      result.workers = workers.stats();
      result.lastState = await state(page, workers).catch(() => null);
      await page.screenshot({ path: resolve(evidence, `${entry.name}-failure.png`), timeout: 5000 }).catch(() => {});
      console.log(`${entry.name}: FAILED ${String(error)}`);
    } finally {
      await bounded(context.close(), "Closing the lifecycle context", 10000).catch(() => {});
    }
  }
} finally {
  await browser?.close();
  await writeFile(resolve(evidence, "results.json"), JSON.stringify({
    timestamp: new Date().toISOString(), cycles,
    policy: prototypeContentSecurityPolicy,
    methodology: "Counts live dedicated Workers using browser close events; observes MapLibre removal and WebGL context loss while retaining instrumentation references. It does not assert heap or GPU memory consumption or real-device performance.",
    results, requests: server.requests,
  }, null, 2));
  await server.close();
}
assert(results.length === 2 && results.every(result => result.passed), "Lifecycle acceptance failed; see target/vector-basemap-lifecycle/evidence/results.json");
