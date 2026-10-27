// Real Leaflet/SVG workload comparisons for 40,000 pipe features.
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const templateRoot = resolve(root, "src_frontend/template-scripts");
const sourceRoot = resolve(templateRoot, "src").replaceAll("\\", "/");
const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => arg.replace(/^--/, "").split(/=(.*)/s, 2)),
);
const samples = Math.max(1, Number(args.samples || 3));
const stage = args.stage || "after";
const parentData = args["parent-data"] === "true";
const initialOnly = args["initial-only"] === "true";
const framed = parentData || args.frame === "true";
if (parentData && stage !== "after") throw Error("parent-data requires current after source");
if (!["before", "phase1", "after"].includes(stage))
  throw Error("stage must be before, phase1 or after");
const baseline = execFileSync("git", ["rev-parse", args.baseline || "HEAD"], {
  cwd: root,
  encoding: "utf8",
}).trim();
const padding = Number(args.padding ?? 0.2),
  minPixelSize = Number(args["min-pixel"] ?? 4);
if (!Number.isFinite(padding) || padding < 0 || !Number.isFinite(minPixelSize) || minPixelSize < 0)
  throw Error("Invalid rendering policy");
const timeoutMs = Math.max(1000, Number(args["timeout-ms"] || 30000));
const { chromium } = await import(
  args["playwright-path"] ? pathToFileURL(resolve(args["playwright-path"])).href : "playwright"
);
const cache = new Map();
async function readSource(path) {
  const absolute = resolve(root, path);
  const fromGit =
    stage === "before" ||
    (stage === "phase1" &&
      path !== "src_frontend/template-scripts/src/map/editor/map-editor-shape-geometry.ts");
  if (!fromGit) return readFile(absolute, "utf8");
  if (!cache.has(path))
    cache.set(
      path,
      execFileSync("git", ["show", baseline + ":" + path.replaceAll("\\", "/")], {
        cwd: root,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
      }),
    );
  return cache.get(path);
}
const componentSource = await readFile(
  resolve(root, "src_frontend/frontend/src/components/map/MapIframe.vue"),
  "utf8",
);
const dtoStart = componentSource.indexOf("function plainMessageValue(");
const dtoEnd = componentSource.indexOf("const probeRuntime", dtoStart);
if (dtoStart < 0 || dtoEnd < 0) throw Error("Parent DTO function boundary not found");
const dtoSource = componentSource
  .slice(dtoStart, dtoEnd)
  .replace("(value: unknown): unknown", "(value)");
const vueRuntime = resolve(
  root,
  "src_frontend/frontend/node_modules/vue/dist/vue.runtime.esm-bundler.js",
).replaceAll("\\", "/");
const config = await readSource("src_frontend/template-scripts/vite.config.ts");
const sourceList = await readSource(
  "src_frontend/template-scripts/src/entries/editor-entry-sources.ts",
);
const common = [
  ...sourceList.match(/editorCommonSources = \[([\s\S]*?)\]/)[1].matchAll(/"([^"]+)"/g),
].map((m) => m[1]);
function block(name) {
  const tick = String.fromCharCode(96);
  const match = config.match(
    new RegExp("export const " + name + " = " + tick + "([\\s\\S]*?)" + tick + ";"),
  );
  if (!match) throw Error("Missing source block: " + name);
  return match[1];
}
const prelude = block("editorCommonPrelude"),
  editorSources = {};
for (const entry of ["map", "map-mobile"]) {
  const list = sourceList.match(
    new RegExp('(?:"' + entry + '"|' + entry + "): \\[([\\s\\S]*?)\\]"),
  )?.[1];
  if (!list) throw Error("Missing editor entry: " + entry);
  const paths = [...common, ...[...list.matchAll(/"([^"]+)"/g)].map((m) => m[1])];
  const sources = await Promise.all(
    paths.map((path) => readSource("src_frontend/template-scripts/" + path)),
  );
  editorSources[entry] =
    prelude.match(/^import .*;$/gm).join("\n") +
    "\nexport function initializeBenchmarkEditor(){\n" +
    prelude.replace(/^import .*;$/gm, "") +
    "\nconst editorEntryProfile=Object.freeze({isMobile:" +
    (entry === "map-mobile") +
    ",interactionVerb:'クリック'});\n" +
    sources
      .map(
        (text, i) =>
          (paths[i].endsWith("map-editor-final.ts") ? block("editorFocusBridge") + "\n" : "") +
          text,
      )
      .join("\n") +
    "\nif(typeof applyEditorMapSnapshot==='function'){const applySnapshot=applyEditorMapSnapshot;applyEditorMapSnapshot=async(snapshot)=>{const timing=window.__shapeSnapshotTiming;if(timing)timing.receivedAt=performance.now();try{return await applySnapshot(snapshot);}finally{if(timing)timing.registeredAt=performance.now();}};}\nreturn {map,shapeRenderer:shapeRenderManager,runtimeId:typeof editorRuntimeId==='string'?editorRuntimeId:null};\n}";
}
const configurations = [
  { label: "editor-pc", entry: "map", viewport: { width: 1024, height: 768 }, cpuRate: 1 },
  {
    label: "editor-mobile",
    entry: "map-mobile",
    viewport: { width: 390, height: 844 },
    cpuRate: 4,
    mobile: true,
  },
  { label: "another-pc", entry: "map-anather", viewport: { width: 1024, height: 768 }, cpuRate: 1 },
  {
    label: "another-mobile",
    entry: "map-anather",
    viewport: { width: 390, height: 844 },
    cpuRate: 4,
    mobile: true,
  },
];
const cases = [
  { name: "spread-40000", count: 40000, kind: "spread", vertices: 2, zoom: 14 },
  { name: "dense-40000", count: 40000, kind: "dense", vertices: 2, zoom: 14 },
  { name: "buffer-first-40000", count: 40000, kind: "buffer", vertices: 2, zoom: 14 },
  { name: "short-40000", count: 40000, kind: "short", vertices: 2, zoom: 14 },
  { name: "multi-vertex-40000", count: 40000, kind: "spread", vertices: 100, zoom: 14 },
  { name: "overview-40000", count: 40000, kind: "dense", vertices: 2, zoom: 5 },
];
const vendors = {
  "/vendor/leaflet.js": "leaflet/dist/leaflet.js",
  "/vendor/leaflet.css": "leaflet/dist/leaflet.css",
  "/vendor/cluster.js": "leaflet.markercluster/dist/leaflet.markercluster.js",
  "/vendor/marked.js": "marked/lib/marked.umd.js",
  "/vendor/xss.js": "xss/dist/xss.min.js",
};
const html = await readFile(new URL("./shape-render-tuning.html", import.meta.url), "utf8");
function instrumentRenderer(source) {
  const original = "export function createShapeRenderManager";
  if (!source.includes(original)) throw Error("Renderer function not found");
  return (
    source.replace(original, "function createShapeRenderManagerBase") +
    "\nexport function createShapeRenderManager(options){\n const observer=window.__shapeBenchmarkObserver; const policy=window.__shapeBenchmarkPolicy||{};\n let manager;\n manager=createShapeRenderManagerBase({...options,...policy,addLayer:(layer,record)=>{options.addLayer(layer,record);observer?.added(String(record.id));},onRefresh:()=>{options.onRefresh?.();observer?.refreshed();}});\n return manager;\n}\n"
  );
}
const server = await createServer({
  root: templateRoot,
  configFile: false,
  publicDir: false,
  logLevel: "error",
  server: { host: "127.0.0.1", port: 0 },
  plugins: [
    {
      name: "shape-render-tuning",
      enforce: "pre",
      resolveId(id) {
        if (id === "/benchmark-parent-dto.ts") return "\0/benchmark-parent-dto.ts";
        if (/^\/benchmark-(map|map-mobile)\.ts$/.test(id)) return "\0" + id;
      },
      async load(id) {
        if (id === "\0/benchmark-parent-dto.ts")
          return `import { toRaw } from "${vueRuntime}"; export ${dtoSource}`;
        const entry = id.match(/^\0\/benchmark-(map|map-mobile)\.ts$/);
        if (entry) return editorSources[entry[1]];
        const path = id.split("?")[0].replaceAll("\\", "/");
        if (!path.startsWith(sourceRoot + "/") || !path.endsWith(".ts")) return;
        let source = await readSource(relative(root, path).replaceAll("\\", "/"));
        if (path.endsWith("/map/common/shape-renderer.ts")) source = instrumentRenderer(source);
        return source;
      },
      configureServer(vite) {
        vite.middlewares.use(async (req, res, next) => {
          const url = new URL(req.url, "http://localhost");
          if (url.pathname === "/measure.html") {
            res.setHeader("Content-Type", "text/html;charset=utf-8");
            res.end(html);
          } else if (vendors[url.pathname]) {
            res.setHeader(
              "Content-Type",
              url.pathname.endsWith(".css") ? "text/css" : "text/javascript",
            );
            res.end(
              await readFile(
                resolve(root, "src_frontend/frontend/node_modules", vendors[url.pathname]),
              ),
            );
          } else if (url.pathname.startsWith("/blank/")) {
            res.setHeader("Content-Type", "image/png");
            res.end(
              Buffer.from(
                "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jQqkAAAAASUVORK5CYII=",
                "base64",
              ),
            );
          } else next();
        });
      },
    },
  ],
});
let browser;
await server.listen();
try {
  browser = await chromium.launch({ headless: true, channel: args.channel || "chrome" });
  const results = [],
    port = server.httpServer.address().port;
  for (const configuration of configurations.filter(
    (c) => !args.entry || c.label.includes(args.entry),
  ))
    for (const test of cases.filter((c) => !args.case || c.name.includes(args.case))) {
      const trials = [];
      for (let i = 0; i < samples; i++) {
        const page = await browser.newPage({
          viewport: configuration.viewport,
          ...(configuration.mobile ? { isMobile: true, hasTouch: true } : {}),
        });
        page.setDefaultTimeout(timeoutMs + 30000);
        if (configuration.cpuRate > 1)
          await (
            await page.context().newCDPSession(page)
          ).send("Emulation.setCPUThrottlingRate", { rate: configuration.cpuRate });
        const errors = [];
        page.on("pageerror", (e) => errors.push(e.message));
        try {
          await page.goto(
            "http://127.0.0.1:" +
              port +
              "/measure.html?entry=" +
              configuration.entry +
              (configuration.mobile ? "&map_ui=mobile" : ""),
          );
          try {
            await page.waitForFunction(() => window.ready, undefined, { timeout: 10000 });
          } catch (error) {
            throw Error(errors.join("\n") || error.message);
          }
          let measurementPage = page;
          if (framed) {
            await page.evaluate(() => {
              window.__sendBenchmarkSnapshot = (target, message, timeoutMs) =>
                new Promise((resolve, reject) => {
                  let sendSyncMs = 0;
                  let dtoMs = 0;
                  const receive = (event) => {
                    if (
                      event.source !== target ||
                      event.origin !== location.origin ||
                      event.data?.type !== "mapObjectsInitializeResult" ||
                      event.data.requestId !== message.requestId
                    )
                      return;
                    cleanup();
                    if (event.data.success) resolve({ sendSyncMs, dtoMs });
                    else reject(Error("Snapshot application rejected"));
                  };
                  const timer = setTimeout(() => {
                    cleanup();
                    reject(Error("Snapshot ACK timed out"));
                  }, timeoutMs);
                  const cleanup = () => {
                    clearTimeout(timer);
                    removeEventListener("message", receive);
                  };
                  addEventListener("message", receive);
                  const started = performance.now();
                  try {
                    target.postMessage(message, location.origin);
                  } catch (error) {
                    if (error.name !== "DataCloneError") throw error;
                    const dtoStart = performance.now();
                    const snapshot = window.__benchmarkPlainMessageValue(message.snapshot);
                    dtoMs = performance.now() - dtoStart;
                    target.postMessage({ ...message, snapshot }, location.origin);
                  }
                  sendSyncMs = performance.now() - started;
                });
              const iframe = document.createElement("iframe");
              iframe.dataset.benchmark = "parent-data";
              iframe.style.cssText = "position:fixed;inset:0;width:100vw;height:100vh;border:0";
              iframe.src = location.href;
              document.body.replaceChildren(iframe);
            });
            const iframe = await page.waitForSelector("iframe[data-benchmark]");
            measurementPage = await iframe.contentFrame();
            await measurementPage.waitForFunction(() => window.ready);
          }
          const trial = await measurementPage.evaluate(
            async ({ test, policy, timeoutMs, parentData, initialOnly }) => {
              let timer;
              try {
                return await Promise.race([
                  window.measure(test, policy, timeoutMs, parentData, initialOnly),
                  new Promise((_, reject) => {
                    timer = setTimeout(
                      () => reject(Error("Unresponsive benchmark")),
                      timeoutMs + 30000,
                    );
                  }),
                ]);
              } finally {
                clearTimeout(timer);
              }
            },
            { test, policy: { padding, minPixelSize }, timeoutMs, parentData, initialOnly },
          );
          if (errors.length) throw Error(errors.join("\n"));
          if (
            trial.status === "complete" &&
            (trial.initial.renderedCount !== trial.expected.total ||
              trial.initial.creations !== trial.expected.total ||
              trial.initial.viewportAdded !== trial.expected.viewport)
          )
            throw Error("Candidate count invariant failed: " + JSON.stringify(trial.initial));
          if (
            trial.afterMove &&
            (trial.afterMove.final.renderedCount !== 0 ||
              trial.afterMove.final.pendingCount !== 0 ||
              trial.afterMove.final.inactiveCachedCount > 256 ||
              trial.afterMove.final.inactiveCachedVertices > 50000)
          )
            throw Error("Move/cache invariant failed");
          trials.push(trial);
        } finally {
          await page.close();
        }
      }
      const median = (key) => {
        const values = trials.map((t) => t.initial[key]).filter((v) => v !== null);
        return values.length ? values.sort((a, b) => a - b)[Math.floor(values.length / 2)] : null;
      };
      const summary = {
        completed: trials.filter((t) => t.status === "complete").length,
        snapshotDtoMs: median("snapshotDtoMs"),
        snapshotTransferMs: median("snapshotTransferMs"),
        snapshotRegistrationMs: median("snapshotRegistrationMs"),
        snapshotAckMs: median("snapshotAckMs"),
        snapshotSendSyncMs: median("snapshotSendSyncMs"),
        initialHeapBytes: median("initialHeapBytes"),
        firstAddMs: median("firstAddMs"),
        firstViewportAddMs: median("firstViewportAddMs"),
        viewportReadyMs: median("viewportReadyMs"),
        readyMs: median("readyMs"),
        elapsedMs: median("elapsedMs"),
        creations: median("creations"),
        expected: trials[0].expected,
      };
      results.push({ configuration, ...test, summary, trials });
      console.log(
        JSON.stringify({
          stage,
          entry: configuration.label,
          case: test.name,
          padding,
          minPixelSize,
          ...summary,
        }),
      );
    }
  const result = {
    stage,
    baseline,
    gitHead: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
    parentData,
    initialOnly,
    framed,
    canonicalCopies: framed ? 2 : 1,
    browser: browser.version(),
    samples,
    policy: { padding, minPixelSize },
    timeoutMs,
    notes:
      "Synthetic pipe fixtures; source is real editor entry composition or read-only runtime. before uses baseline revision; phase1 uses current geometry only with all other baseline TS; after uses worktree. Benchmark-only instrumentation injects policy and observes addLayer. Timings exclude module loading/network/JSON transfer/fixture preparation. parentData=true uses a real same-origin iframe and native postMessage structured clone from its parent, recording DTO conversion on DataCloneError only (the fallback function extracted from MapIframe.vue with real Vue toRaw), transfer, application and ACK times. With frame=true, both modes use an actual iframe and retain two canonical datasets; server mode keeps an outer canonical copy prepared before timing. Heap values are browser process references, not isolated per-frame allocations. firstAdd/viewportReady describe Leaflet layer addition, not GPU paint completion. Mobile CPU4 is emulation. A timeout is recorded with partial counts and must not be interpreted as completion. Buffer fixture deliberately registers padding candidates first. Short fixture has equal numbers of 3/5/7/10 px pipe segments at zoom14; raising threshold removes real segments. Another-map selects its existing initially-OFF group before waiting.",
    results,
  };
  const output = resolve(
    root,
    args.output || "docs/performance/shape-render-tuning-" + stage + ".json",
  );
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(result, null, 2) + "\n");
} finally {
  await browser?.close();
  await server.close();
}
