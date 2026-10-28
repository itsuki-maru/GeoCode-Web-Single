// Real AnswerMapModal + production-built map modules + a localhost read-only Rust server.
// Raw HTML/data/screenshots stay in target/. Reports contain counts/times/bytes only.
import assert from "node:assert/strict";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { createHash } from "node:crypto";
import { build } from "vite";
import vue from "@vitejs/plugin-vue";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const scripts = resolve(root, "src_frontend/frontend/scripts");
const args = Object.fromEntries(process.argv.slice(2).map((arg) => arg.replace(/^--/, "").split(/=(.*)/s, 2)));
const output = resolve(root, args.output || "target/answer-map-browser");
const targetRoot = resolve(root, "target") + sep;
if (!output.startsWith(targetRoot)) throw Error("Benchmark output must stay under target/");
const modes = (args.modes || "pc,mobile").split(",");
if (modes.some((mode) => !["pc", "mobile"].includes(mode))) throw Error("Invalid benchmark modes");
const normalize = (path) => path.replaceAll("\\", "/").split("?")[0];
const stateExpose = `
defineExpose({
  benchmarkState: () => ({
    loading: loading.value, busy: busy.value, error: !!error.value,
    filterError: !!filterError.value, scopeReady: scopeReady.value,
    initialCount: initialCount.value, matchedCount: matchedCount.value,
    visibleCount: visibleCount.value, renderableCount: renderableCount.value,
    answerCount: answerCount.value, coloringActive: coloringActive.value,
    preparingPrint: preparingPrint.value, printSnapshot: !!printSnapshot.value,
    printTargets: printSnapshot.value ? Object.keys((printSnapshot.value as any).bootstrap.markers).length + (printSnapshot.value as any).bootstrap.shapes.length : 0,
    forms: forms.value.length, fields: fields.value.length,
  }),
  benchmarkFilter: async (operation: string) => {
    if (operation === "clear") return fetchResult(false, true);
    selectedForm.value = (window as any).__ANSWER_MAP_BENCH_OPTIONS__.preferredFormId || forms.value[0]?.id || "";
    rows.value = [];
    await fetchResult(true);
    if (operation === "filled") {
      const preferred = (window as any).__ANSWER_MAP_BENCH_OPTIONS__;
      const field = fields.value.find((field) => field.id === preferred.preferredFieldId && field.field_type === preferred.preferredFieldType)
        || fields.value.find((field) => field.field_type !== "unknown");
      if (!field) throw new Error("Benchmark requires a declared form field");
      rows.value = [{ id: ++nextId, key: fieldKey(field), op: "filled", value: "", upper: "", selected: [] }];
    }
    return fetchResult(false);
  },
  benchmarkColor: async (enabled: boolean) => {
    if (!enabled) return fetchResult(false, false, { specification: null });
    selectedForm.value = (window as any).__ANSWER_MAP_BENCH_OPTIONS__.preferredFormId || forms.value[0]?.id || "";
    rows.value = [];
    await fetchResult(true);
    const preferred = (window as any).__ANSWER_MAP_BENCH_OPTIONS__;
    const field = fields.value.find((field) => field.id === preferred.preferredFieldId && field.field_type === preferred.preferredFieldType)
      || fields.value.find((field) => field.field_type !== "unknown");
    if (!selectedForm.value || !field) throw new Error("Benchmark requires a declared form field");
    return fetchResult(false, false, { specification: {
      common_form_id: selectedForm.value,
      rules: ["filled", "empty", "missing"].map((op, index) => ({
        id: "benchmark-" + op, label: "Benchmark " + op,
        color: ["#d73027", "#2166ac", "#1a9850"][index],
        conditions: [{ field_id: field.id, field_type: field.field_type, op }],
      })),
    }});
  },
  benchmarkPrint: () => openPrint(),
  benchmarkClearPrint: () => { printSnapshot.value = null; filterError.value = ""; },
  benchmarkCsvCheck: async () => {
    const payload = { query: baseQuery.value, targets: initialTargets.value, common_form_id: null, conditions: [], options_only: false };
    const requestBytes = new TextEncoder().encode(JSON.stringify(payload)).length;
    try {
      const response = await apiClient.post(csvCheckAction.value, payload);
      return { status: response.status, requestBytes, answerLimitRejected: false };
    } catch (cause: any) {
      const text = JSON.stringify(cause.response?.data || "");
      return { status: cause.response?.status || 0, requestBytes, answerLimitRejected: text.includes("CSV") && (text.includes("10,000") || text.includes("10000")) };
    }
  },
});
`;
await mkdir(output, { recursive: true });
for (const mode of modes) {
  const app = resolve(root, "src_frontend", mode === "mobile" ? "frontend-mobile" : "frontend");
  const component = normalize(resolve(app, "src/components/map-object/AnswerMapModal.vue"));
  const mapEntry = normalize(resolve(root, "src_frontend/template-scripts/src/entries/form-answer-map.ts"));
  const printPreview = normalize(resolve(root, "src_frontend/template-scripts/src/map/print/print-preview.ts"));
  const printState = normalize(resolve(root, "src_frontend/template-scripts/src/map/print/answer-print-state.ts"));
  await build({
    configFile: false,
    root: app,
    publicDir: false,
    logLevel: "error",
    base: `/__bench/${mode}/`,
    define: { "import.meta.env.VITE_IP_ADDRESS": JSON.stringify("") },
    plugins: [
      {
        name: "answer-map-private-benchmark", enforce: "pre",
        async load(id) {
          if (id.includes("?")) return null;
          const path = normalize(id);
          if (path === component) return (await readFile(id, "utf8")).replace("</script>", `${stateExpose}\n</script>`);
          if (path === mapEntry) {
            const source = await readFile(id, "utf8");
            const marker = 'const runtime = initializeReadOnlyMapPage("form-answer-map");';
            if (!source.includes(marker)) throw Error("Map runtime capture marker changed");
            return source.replace(marker, marker + "\n(window as any).__answerMapRuntime = runtime;");
          }
          if (path === printPreview) {
            const source = await readFile(id, "utf8");
            const marker = "const runtime = initializeReadOnlyMapPage(page, state);";
            if (!source.includes(marker)) throw Error("Print runtime capture marker changed");
            return source.replace(marker, marker + "\n(window as any).__answerPrintRuntime = runtime;");
          }
          if (path === printState) {
            const source = await readFile(id, "utf8");
            const marker = "return new TextEncoder().encode(JSON.stringify(v)).length <= MAX_ANSWER_PRINT_BYTES;";
            if (!source.includes(marker)) throw Error("Print byte validation marker changed");
            return source.replace(marker, `const measuredBytes = new TextEncoder().encode(JSON.stringify(v)).length;
              const measurement = (window as any).__answerPrintMeasurement;
              if (measurement?.active) { measurement.bytes = measuredBytes; measurement.structurallyValid = true; }
              return measuredBytes <= MAX_ANSWER_PRINT_BYTES;`);
          }
          if (path === normalize(resolve(app, "src/axiosClient.ts"))) {
            // No real authentication/session is used by the isolated read-only server.
            // Keep real Axios requests; omit unrelated application routing/auth imports.
            return 'import axios from "axios"; const client=axios.create({baseURL:"",withCredentials:true}); client.isAxiosError=axios.isAxiosError; export default client;';
          }
        },
      },
      vue(),
    ],
    resolve: { dedupe: ["vue", "pinia"], alias: { "@": resolve(app, "src"), "@bench-component": component } },
    build: {
      outDir: resolve(output, "build", mode), emptyOutDir: true,
      minify: true, cssCodeSplit: false,
      rollupOptions: {
        input: {
          parent: resolve(scripts, "answer-map-benchmark-entry.ts"),
          map: resolve(scripts, "answer-map-runtime-benchmark-entry.ts"),
          print: resolve(root, "src_frontend/template-scripts/src/entries/form-answer-map-print.ts"),
        },
        output: { entryFileNames: "[name].js", chunkFileNames: "chunks/[name]-[hash].js", assetFileNames: "[name][extname]" },
      },
    },
  });
}
if (args["build-only"] === "true") {
  console.log(JSON.stringify({ builtModes: modes.length }));
  process.exit(0);
}
const backend = new URL(args.backend || "http://127.0.0.1:0");
if (backend.protocol !== "http:" || backend.hostname !== "127.0.0.1" || !Number(backend.port)) throw Error("A localhost read-only benchmark backend is required");
const manifestPath = resolve(root, args.manifest || "target/answer-map-private/manifest.json");
if (![targetRoot, resolve(root, "GeoCode-Web-Single/target") + sep].some((folder) => manifestPath.startsWith(folder))) throw Error("Private manifest must stay under a repository target/");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const query = manifest.query || { mode: "history" };
const selectedForm = manifest.scenarios?.find((scenario) => scenario.name === "selected_form");
const filledCase = manifest.scenarios?.find((scenario) => scenario.name === "filled");
const harnessOptions = {
  query,
  preferredFormId: selectedForm?.formId,
  preferredFieldId: filledCase?.fieldId,
  preferredFieldType: filledCase?.fieldType,
};
const requests = [];
let activeMode = modes[0];
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#e9edf0"/></svg>';
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, "http://localhost");
    if (request.headers.origin && request.headers.origin !== origin) return response.writeHead(403).end();
    if (url.pathname === "/benchmark.html") {
      activeMode = url.searchParams.get("mode") || modes[0];
      if (!modes.includes(activeMode)) return response.writeHead(400).end();
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(`<!doctype html><html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/__bench/${activeMode}/style.css"><style>html,body,#host{margin:0;width:100%;height:100%;font-family:sans-serif}</style><div id="host"></div><script>window.__ANSWER_MAP_BENCH_OPTIONS__=${JSON.stringify({ ...harnessOptions, mobile: activeMode === "mobile" }).replaceAll("<", "\\u003c")};</script><script type="module" src="/__bench/${activeMode}/parent.js"></script></html>`);
      return;
    }
    if (url.pathname.startsWith("/__bench/")) {
      const path = resolve(output, "build", "." + url.pathname.slice("/__bench".length));
      if (!path.startsWith(resolve(output, "build") + sep)) return response.writeHead(403).end();
      response.setHeader("Content-Type", { ".js": "text/javascript", ".css": "text/css" }[extname(path)] || "application/octet-stream");
      response.end(await readFile(path));
      return;
    }
    if (url.pathname.startsWith("/form-answers/") || url.pathname.startsWith("/assets/")) {
      const chunks = [];
      let bytes = 0;
      for await (const chunk of request) {
        bytes += chunk.length;
        if (bytes > 1024 * 1024) return response.writeHead(413).end();
        chunks.push(chunk);
      }
      const start = performance.now();
      const upstream = await fetch(new URL(url.pathname + url.search, backend), {
        method: request.method,
        headers: {
          ...(request.headers["content-type"] ? { "content-type": request.headers["content-type"] } : {}),
          ...(request.headers.origin ? { origin: request.headers.origin } : {}),
        },
        body: ["GET", "HEAD"].includes(request.method) ? undefined : Buffer.concat(chunks),
        redirect: "manual",
      });
      let body = Buffer.from(await upstream.arrayBuffer());
      const contentType = upstream.headers.get("content-type") || "application/octet-stream";
      if (contentType.includes("text/html")) {
        let html = body.toString("utf8");
        html = html.replaceAll('src="/assets/template-form-answer-map.js"', `src="/__bench/${activeMode}/map.js"`)
          .replaceAll('src="/assets/template-form-answer-map-print.js"', `src="/__bench/${activeMode}/print.js"`);
        body = Buffer.from(html);
      }
      if (url.pathname.startsWith("/form-answers/")) {
        const endpoint = ["/form-answers/map", "/form-answers/map-filter", "/form-answers/map-print", "/form-answers/map-csv-check"].includes(url.pathname) ? url.pathname : "/form-answers/other";
        const item = { endpoint, status: upstream.status, requestBytes: bytes, responseBytes: body.length, proxyMs: performance.now() - start };
        if (endpoint === "/form-answers/map-filter" && upstream.ok) {
          const result = JSON.parse(body.toString("utf8"));
          const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          item.optionsOnly = input.options_only === true;
          item.conditionOps = (input.conditions || []).map((condition) => ["filled", "empty", "missing"].includes(condition.op) ? condition.op : "other");
          item.resultTargets = result.target_count;
          item.resultAnswers = result.answer_count;
        }
        requests.push(item);
      }
      response.writeHead(upstream.status, { "content-type": contentType, "cache-control": "no-store" }).end(body);
      return;
    }
    // All map tiles, private icon/image URLs and popup media are local placeholders.
    response.writeHead(200, { "content-type": "image/svg+xml" }).end(svg);
  } catch {
    response.writeHead(500).end("Benchmark proxy failed");
  }
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${server.address().port}`;
const { chromium } = await import(args["playwright-path"] ? pathToFileURL(resolve(args["playwright-path"])).href : "playwright");
const browser = await chromium.launch({ channel: "chrome", headless: true });
const results = [];
const timeout = Number(args.timeout || 120000);
let failed = false;
try {
  for (const mode of modes) {
    const mobile = mode === "mobile";
    const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 800 }, isMobile: mobile, hasTouch: mobile });
    let blockedExternalRequests = 0, pageErrors = 0;
    await context.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.origin === origin || ["data:", "blob:", "about:"].includes(url.protocol)) return route.continue();
      blockedExternalRequests++;
      if (route.request().resourceType() === "image") return route.fulfill({ contentType: "image/svg+xml", body: svg });
      return route.abort();
    });
    await context.addInitScript(() => {
      window.__benchmarkLongTasks = [];
      try {
        new PerformanceObserver((list) => {
          window.__benchmarkLongTasks.push(...list.getEntries().map((entry) => ({ at: performance.timeOrigin + entry.startTime, ms: entry.duration })));
        }).observe({ type: "longtask", buffered: true });
      } catch { /* optional browser diagnostic */ }
    });
    const page = await context.newPage();
    page.on("pageerror", () => { pageErrors++; });
    const cdp = await context.newCDPSession(page);
    await cdp.send("Performance.enable");
    if (mobile) await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
    const result = { mode, viewport: mobile ? [390, 844] : [1280, 800], cpuRate: mobile ? 4 : 1, phases: [], cycles: [] };
    const heap = async () => {
      await cdp.send("HeapProfiler.collectGarbage");
      const metrics = await cdp.send("Performance.getMetrics");
      return metrics.metrics.find((item) => item.name === "JSHeapUsedSize")?.value ?? null;
    };
    const mapFrame = () => page.frames().find((frame) => new URL(frame.url() || "about:blank").pathname === "/form-answers/map");
    const ready = async () => {
      await page.waitForFunction(() => {
        const value = window.__answerMapBenchmark?.state();
        const colorFieldset = document.querySelector(".color-panel fieldset");
        return value && !value.closed && (value.error || value.filterError || (value.scopeReady && !value.loading && !value.busy && !colorFieldset?.disabled));
      }, null, { timeout });
      const state = await page.evaluate(() => window.__answerMapBenchmark.state());
      assert.equal(state.error || state.filterError, false, "Actual map modal reported an error");
      const frame = mapFrame();
      assert.ok(frame, "Map iframe must exist");
      await frame.waitForFunction(() => !!window.__answerMapRuntimeBenchmark, null, { timeout });
      await frame.evaluate(() => window.__answerMapRuntimeBenchmark.settle());
      await frame.waitForFunction(() => window.__answerMapRuntimeBenchmark.pending() === 0, null, { timeout });
      return frame;
    };
    const phase = async (name, action, collect = true) => {
      result.attemptedPhase = name;
      const startedAt = Date.now(), started = performance.now(), firstRequest = requests.length;
      await action();
      const frame = collect ? await ready() : null;
      const entry = { name, ms: performance.now() - started, requests: requests.slice(firstRequest) };
      if (frame) {
        entry.map = await frame.evaluate(() => window.__answerMapRuntimeBenchmark.counts());
        entry.modal = await page.evaluate(() => window.__answerMapBenchmark.state());
      }
      const tasks = [];
      for (const current of page.frames()) {
        try { tasks.push(...await current.evaluate((at) => (window.__benchmarkLongTasks || []).filter((item) => item.at >= at).map((item) => item.ms), startedAt)); } catch { /* detached frame */ }
      }
      entry.longTasks = { count: tasks.length, maxMs: Math.max(0, ...tasks), totalMs: tasks.reduce((sum, ms) => sum + ms, 0) };
      result.phases.push(entry);
      console.log(JSON.stringify({ mode, phase: name, ms: Math.round(entry.ms), pending: entry.map?.pendingCount ?? null, rendered: entry.map?.renderedCount ?? null, logicalShapes: entry.map?.logicalVisibleShapes ?? null }));
      return entry;
    };
    try {
      await page.goto(`${origin}/benchmark.html?mode=${mode}`);
      await page.waitForFunction(() => !!window.__answerMapBenchmark);
      result.heapBeforeOpen = await heap();
      await phase("initial", () => page.evaluate(() => window.__answerMapBenchmark.open()));
      const initial = result.phases.at(-1);
      assert.ok(initial.modal.initialCount > 10000, "Real benchmark needs more than 10000 targets");
      assert.equal(initial.map.recordCount, initial.modal.initialCount, "Fixture contains shapes only");
      assert.equal(initial.map.mobileControls, mobile);
      await phase("csvAnswerLimit", async () => { result.csvLimit = await page.evaluate(() => window.__answerMapBenchmark.csvCheck()); });
      assert.equal(result.csvLimit.status, 400);
      assert.equal(result.csvLimit.answerLimitRejected, true);
      assert.ok(result.csvLimit.requestBytes <= 1024 * 1024);
      for (const operation of ["pan", "zoomIn", "pan", "zoomOut"]) await phase(operation, async () => (await ready()).evaluate((value) => window.__answerMapRuntimeBenchmark.move(value), operation));
      await phase("filterFilled", () => page.evaluate(() => window.__answerMapBenchmark.filter("filled")));
      if (filledCase) {
        assert.equal(result.phases.at(-1).modal.matchedCount, filledCase.targetCount);
        assert.equal(result.phases.at(-1).modal.answerCount, filledCase.answerCount);
      }
      await phase("clearFilter", () => page.evaluate(() => window.__answerMapBenchmark.filter("clear")));
      assert.equal(result.phases.at(-1).modal.matchedCount, initial.modal.initialCount);
      await phase("threeClassifications", () => page.evaluate(() => window.__answerMapBenchmark.color(true)));
      assert.equal(result.phases.at(-1).map.coloringRules, 3);
      if (selectedForm) assert.equal(result.phases.at(-1).map.coloredTargets, selectedForm.targetCount);
      for (const scenario of manifest.scenarios || []) {
        if (!["filled", "empty", "missing"].includes(scenario.name)) continue;
        const measured = result.phases.at(-1).requests.find((item) => !item.optionsOnly && item.conditionOps?.length === 1 && item.conditionOps[0] === scenario.name);
        assert.ok(measured, "Every classification must issue its real API request");
        assert.equal(measured.resultTargets, scenario.targetCount);
        assert.equal(measured.resultAnswers, scenario.answerCount);
      }
      await phase("filterWhileColored", () => page.evaluate(() => window.__answerMapBenchmark.filter("filled")));
      await phase("clearFilterWhileColored", () => page.evaluate(() => window.__answerMapBenchmark.filter("clear")));
      await phase("clearColoring", () => page.evaluate(() => window.__answerMapBenchmark.color(false)));
      assert.equal(result.phases.at(-1).map.coloringRules, 0);
      let popup;
      await phase("popup", async () => { popup = await (await ready()).evaluate(() => window.__answerMapRuntimeBenchmark.popup()); });
      result.popup = popup;
      assert.equal(popup.available && popup.opened, true, "A real rendered shape popup must open");
      if (!mobile) {
        result.fullPrint = await (await ready()).evaluate(() => window.__answerMapRuntimeBenchmark.printProbe());
        assert.equal(result.fullPrint.structurallyValid, true, "Full print input must pass every structural check");
        assert.ok(result.fullPrint.accepted || result.fullPrint.capacityRejected, "Full print must succeed or hit the retained byte guard");
        if (result.fullPrint.capacityRejected) assert.ok(result.fullPrint.bytes > result.fullPrint.capacityBytes);
        if (result.fullPrint.accepted) {
          result.syntheticPrintGuard = await (await ready()).evaluate(() => window.__answerMapRuntimeBenchmark.guardProbe());
          assert.equal(result.syntheticPrintGuard.rejected && result.syntheticPrintGuard.structurallyValid, true);
          assert.ok(result.syntheticPrintGuard.bytes > result.syntheticPrintGuard.capacityBytes);
        }
        await phase("printMask1000", async () => (await ready()).evaluate(() => window.__answerMapRuntimeBenchmark.legendMask(true, 1000)));
        await page.waitForFunction(() => window.__answerMapBenchmark.state().visibleCount <= 1000, null, { timeout });
        await phase("print1000", async () => {
          const printStartedAt = performance.now();
          await page.evaluate(() => window.__answerMapBenchmark.print());
          await page.waitForFunction(() => window.__answerMapBenchmark.state().printSnapshot || window.__answerMapBenchmark.state().filterError, null, { timeout });
          const state = await page.evaluate(() => window.__answerMapBenchmark.state());
          assert.equal(state.filterError, false, "Bounded print snapshot must succeed");
          assert.ok(state.printTargets > 0 && state.printTargets <= 1000);
          const deadline = Date.now() + timeout;
          let printFrame;
          while (!(printFrame = page.frames().find((frame) => new URL(frame.url() || "about:blank").pathname === "/form-answers/map-print"))) {
            if (Date.now() > deadline) throw Error("Print iframe timeout");
            await page.waitForTimeout(50);
          }
          await printFrame.waitForFunction(() => !!window.__answerPrintRuntime, null, { timeout });
          const runtimeReadyAt = performance.now();
          await printFrame.evaluate(() => window.__answerPrintRuntime.shapeRenderer.whenIdle());
          await printFrame.waitForFunction(() => window.__answerPrintRuntime.shapeRenderer.getStats().pendingCount === 0, null, { timeout });
          const shapesReadyAt = performance.now();
          await printFrame.waitForFunction(() => {
            const button = document.querySelector("#print-submit");
            return !!button && !button.disabled;
          }, null, { timeout });
          const buttonReadyAt = performance.now();
          result.smallPrint = await printFrame.evaluate(() => {
            const runtime = window.__answerPrintRuntime;
            const stats = runtime.shapeRenderer.getStats();
            const mapElement = runtime.map.getContainer();
            const images = new Set(mapElement.querySelectorAll(
              "img.leaflet-tile, .leaflet-marker-pane img, .leaflet-shadow-pane img",
            ));
            // Match print readiness: collapsed popup details intentionally keep
            // their images deferred, so do not count those as pending resources.
            for (const img of mapElement.querySelectorAll(".leaflet-popup-pane img[src]")) {
              let hidden = false;
              for (let parent = img.parentElement; parent; parent = parent.parentElement) {
                if (parent instanceof HTMLDetailsElement && !parent.open) {
                  hidden = true;
                  break;
                }
              }
              if (!hidden) images.add(img);
            }
            const layers = { total: 0, loading: 0, failed: 0, isLoading: 0, printLoading: 0 };
            runtime.map.eachLayer((layer) => {
              layers.total++;
              const loading = !!layer.isLoading?.();
              const printStatus = layer.getPrintStatus?.();
              if (loading) layers.isLoading++;
              if (printStatus?.loading) layers.printLoading++;
              if (loading || printStatus?.loading) layers.loading++;
              if (printStatus?.failed) layers.failed++;
            });
            const objects = runtime.getObjectLoadStatus?.() || {};
            return {
              targets: stats.recordCount,
              ...stats,
              buttonText: document.querySelector("#print-submit")?.textContent?.trim() || "",
              status: document.querySelector("#print-status")?.textContent?.trim() || "",
              incompleteImages: [...images].filter((img) => !img.complete).length,
              failedImages: [...images].filter((img) => img.complete && img.naturalWidth === 0).length,
              layers,
              objectLoadStatus: { loading: !!objects.loading, failed: !!objects.failed },
            };
          });
          result.smallPrint.timings = {
            runtimeReadyMs: runtimeReadyAt - printStartedAt,
            shapesAfterRuntimeMs: shapesReadyAt - runtimeReadyAt,
            shapesReadyMs: shapesReadyAt - printStartedAt,
            buttonWaitAfterShapesMs: buttonReadyAt - shapesReadyAt,
            buttonReadyMs: buttonReadyAt - printStartedAt,
          };
          assert.equal(result.smallPrint.pendingCount, 0);
          if (args.screenshots === "true") await page.screenshot({ path: resolve(output, "private-print.png") });
          await page.evaluate(() => window.__answerMapBenchmark.clearPrint());
        });
        await phase("clearPrintMask", async () => (await ready()).evaluate(() => window.__answerMapRuntimeBenchmark.legendMask(false)));
      }
      result.heapOpenAfterOperations = await heap();
      for (let cycle = 0; cycle < Number(args.cycles || 3); cycle++) {
        await phase(`close${cycle + 1}`, () => page.evaluate(() => window.__answerMapBenchmark.close()), false);
        await page.waitForTimeout(100);
        const closedHeap = await heap();
        const retained = await page.evaluate(() => window.__answerMapBenchmark.retainedRuntimes());
        result.cycles.push({ cycle: cycle + 1, closedHeap, retainedRuntimes: retained, iframeCount: await page.locator("iframe").count() });
        assert.equal(result.cycles.at(-1).iframeCount, 0, "Closing must remove all map frames");
        assert.equal(retained, 0, "Closed runtime must be collectable after GC");
        if (cycle < Number(args.cycles || 3) - 1) await phase(`reopen${cycle + 1}`, () => page.evaluate(() => window.__answerMapBenchmark.open()));
      }
      result.blockedExternalRequests = blockedExternalRequests;
      result.pageErrors = pageErrors;
      assert.equal(pageErrors, 0, "No browser exceptions are allowed");
      result.completed = true;
    } catch (error) {
      result.completed = false;
      result.failedAfterPhase = result.attemptedPhase || "startup";
      result.failureType = ["Error", "AssertionError", "TimeoutError"].includes(error?.name) ? error.name : "Error";
      result.failureNetworkCode = String(error?.message || "").match(/net::ERR_[A-Z_]+/)?.[0] || null;
      result.modalAtFailure = await page.evaluate(() => window.__answerMapBenchmark?.state() || null).catch(() => null);
      result.apiAtFailure = requests.filter((item) => item.endpoint.startsWith("/form-answers/"));
      result.pageErrors = pageErrors;
      result.blockedExternalRequests = blockedExternalRequests;
      failed = true;
      if (args.screenshots === "true") await page.screenshot({ path: resolve(output, `private-failure-${mode}.png`) }).catch(() => {});
    } finally {
      results.push(result);
      await context.close();
    }
  }
  const report = {
    measuredAt: new Date().toISOString(), browser: browser.version(),
    dataset: { answers: manifest.answers, targets: manifest.targets, markers: manifest.markers, shapes: manifest.shapes, htmlBytes: manifest.htmlBytes },
    sourceSha256: Object.fromEntries(await Promise.all([
      "src_frontend/frontend/src/components/map-object/AnswerMapModal.vue",
      "src_frontend/frontend-mobile/src/components/map-object/AnswerMapModal.vue",
      "src_frontend/template-scripts/src/map/read-only-page.ts",
      "src_frontend/template-scripts/src/map/common/shape-renderer.ts",
      "src_frontend/template-scripts/src/map/answer-filter.ts",
      "src_frontend/template-scripts/src/map/answer-coloring.ts",
      "src_frontend/template-scripts/src/map/print/answer-print-state.ts",
    ].map(async (path) => [path, createHash("sha256").update(await readFile(resolve(root, path))).digest("hex")]))),
    results,
    notes: [
      "Production-built real PC/mobile AnswerMapModal, map/filter/color/print modules; benchmark-only expose/runtime captures are injected at build time.",
      "Uses real read-only Rust map, map-filter and map-print HTTP endpoints through a localhost proxy. Original 1MiB request cap is retained.",
      "External requests are blocked; tiles/icons/media are local placeholders. Network tile latency and real authentication are excluded.",
      "Raw HTML/geometry/answer contents remain local; reports contain only aggregate counts, timings and byte sizes.",
      "PC 1280x800; mobile 390x844 with CPU4x emulation, not a physical mobile device. The real fixture contains shapes, not a large marker population.",
      "The ordinary parent editing map and Pinia raw-record store are not mounted concurrently. This does not guarantee whole-application or physical-device memory usage.",
      "Logical visible targets are independent from generated Leaflet objects and SVG DOM counts; all are reported separately.",
      "Operation timings include endpoint work, HTTP/JSON, Vue, iframe rendering and settling plus automation coordination. Do not add them to backend-only measurements.",
      "Heap values are Chrome JS heap after forced GC, not full browser/process memory. Long tasks may be observed by both same-process frame contexts.",
      "Full print may be normally rejected by the retained 32MiB byte cap; successful bounded print uses an actual legend mask of at most1000 targets.",
    ],
  };
  await writeFile(resolve(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ modes: results.length, completed: results.filter((item) => item.completed).length }));
} finally {
  await browser.close();
  await new Promise((done) => server.close(done));
}
if (failed) process.exitCode = 1;
