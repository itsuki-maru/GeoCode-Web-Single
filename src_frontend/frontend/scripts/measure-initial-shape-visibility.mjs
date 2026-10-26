// Real editor source composition and Leaflet/SVG measurement for initial visibility.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const templateRoot = resolve(root, "src_frontend/template-scripts");
const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => arg.replace(/^--/, "").split(/=(.*)/s, 2)),
);
const samples = Math.max(1, Number(args.samples || 3));
const { chromium } = await import(
  args["playwright-path"] ? pathToFileURL(resolve(args["playwright-path"])).href : "playwright"
);
const config = await readFile(resolve(templateRoot, "vite.config.ts"), "utf8");
const sourceList = await readFile(
  resolve(templateRoot, "src/entries/editor-entry-sources.ts"),
  "utf8",
);
const commonSources = [
  ...sourceList.match(/editorCommonSources = \[([\s\S]*?)\]/)[1].matchAll(/"([^"]+)"/g),
].map((match) => match[1]);
const block = (name) => {
  const tick = String.fromCharCode(96);
  const result = config.match(
    new RegExp("export const " + name + " = " + tick + "([\\s\\S]*?)" + tick + ";"),
  );
  if (!result) throw Error("Missing editor source block: " + name);
  return result[1];
};
const editorPrelude = block("editorCommonPrelude");
const importLines = editorPrelude.match(/^import .*;$/gm).join("\n");
const innerPrelude = editorPrelude.replace(/^import .*;$/gm, "");
const editorSources = {};
for (const entry of ["map", "map-mobile"]) {
  const list = sourceList.match(
    new RegExp('(?:"' + entry + '"|' + entry + "): \\[([\\s\\S]*?)\\]"),
  )?.[1];
  if (!list) throw Error("Missing editor source list: " + entry);
  const paths = [...commonSources, ...[...list.matchAll(/"([^"]+)"/g)].map((match) => match[1])];
  const sources = await Promise.all(
    paths.map((path) => readFile(resolve(templateRoot, path), "utf8")),
  );
  const body = sources
    .map(
      (text, index) =>
        (paths[index].endsWith("map-editor-final.ts") ? block("editorFocusBridge") + "\n" : "") +
        text,
    )
    .join("\n");
  // Only a function wrapper is added to the actual entry composition. Module
  // loading finishes before timing the synchronous initialization statements.
  editorSources[entry] =
    importLines +
    "\nexport function initializeBenchmarkEditor(){\n" +
    innerPrelude +
    "\nconst editorEntryProfile=Object.freeze({isMobile:" +
    (entry === "map-mobile") +
    ",interactionVerb:'クリック'});\n" +
    body +
    "\nreturn {map,shapeRenderer:shapeRenderManager};\n}";
}
const cases = [
  { name: "spread-10000-z14", count: 10000, vertices: 2, zoom: 14, expected: 80 },
  { name: "dense-10000-z5", count: 10000, vertices: 2, zoom: 5, dense: true, expected: 0 },
  { name: "dense-2500-z14", count: 2500, vertices: 2, zoom: 14, dense: true, expected: 2500 },
  { name: "spread-2500-v100-z14", count: 2500, vertices: 100, zoom: 14, expected: 80 },
];
const configurations = [
  { entry: "map", label: "editor-pc", viewport: { width: 1024, height: 768 }, cpuRate: 1 },
  {
    entry: "map-mobile",
    label: "editor-mobile",
    viewport: { width: 390, height: 844 },
    cpuRate: 4,
    mobile: true,
  },
  { entry: "map-anather", label: "another-pc", viewport: { width: 1024, height: 768 }, cpuRate: 1 },
  {
    entry: "map-anather",
    label: "another-mobile",
    viewport: { width: 390, height: 844 },
    cpuRate: 4,
    mobile: true,
  },
];
const vendors = {
  "/vendor/leaflet.js": "leaflet/dist/leaflet.js",
  "/vendor/leaflet.css": "leaflet/dist/leaflet.css",
  "/vendor/cluster.js": "leaflet.markercluster/dist/leaflet.markercluster.js",
  "/vendor/marked.js": "marked/lib/marked.umd.js",
  "/vendor/xss.js": "xss/dist/xss.min.js",
};
const html = await readFile(new URL("./shape-initial-visibility.html", import.meta.url), "utf8");
const server = await createServer({
  root: templateRoot,
  configFile: false,
  publicDir: false,
  logLevel: "error",
  server: { host: "127.0.0.1", port: 0 },
  plugins: [
    {
      name: "initial-shape-visibility-measurement",
      enforce: "pre",
      resolveId(id) {
        if (/^\/benchmark-(map|map-mobile)\.ts$/.test(id)) return "\0" + id;
      },
      load(id) {
        const match = id.match(/^\0\/benchmark-(map|map-mobile)\.ts$/);
        if (match) return editorSources[match[1]];
      },
      configureServer(vite) {
        vite.middlewares.use(async (req, res, next) => {
          const url = new URL(req.url, "http://localhost");
          if (url.pathname === "/measure.html") {
            res.setHeader("Content-Type", "text/html; charset=utf-8");
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
  const port = server.httpServer.address().port,
    results = [];
  for (const configuration of configurations.filter(
    (test) => !args.entry || test.label.includes(args.entry),
  )) {
    for (const test of cases.filter((test) => !args.case || test.name.includes(args.case))) {
      for (const mode of ["auto", "manual"]) {
        const trials = [];
        for (let i = 0; i < samples; i++) {
          const page = await browser.newPage({
            viewport: configuration.viewport,
            ...(configuration.mobile ? { isMobile: true, hasTouch: true } : {}),
          });
          page.setDefaultTimeout(60000);
          if (configuration.cpuRate > 1)
            await (
              await page.context().newCDPSession(page)
            ).send("Emulation.setCPUThrottlingRate", { rate: configuration.cpuRate });
          const errors = [];
          page.on("pageerror", (error) => errors.push(error.message));
          let trial;
          try {
            await page.goto(
              "http://127.0.0.1:" +
                port +
                "/measure.html?entry=" +
                configuration.entry +
                (configuration.mobile ? "&map_ui=mobile" : ""),
            );
            await page.waitForFunction(() => window.ready);
            trial = await page.evaluate(
              async ({ test, mode }) => {
                let timer;
                try {
                  return await Promise.race([
                    window.measure(test, mode),
                    new Promise((_, reject) => {
                      timer = setTimeout(
                        () => reject(Error("Measurement did not settle within 60 seconds")),
                        60000,
                      );
                    }),
                  ]);
                } finally {
                  clearTimeout(timer);
                }
              },
              { test, mode },
            );
          } finally {
            await page.close();
          }
          if (errors.length) throw Error(errors.join("\n"));
          if (trial.initial.creations !== test.expected)
            throw Error(
              configuration.label +
                " " +
                test.name +
                ": unexpected creation count " +
                trial.initial.creations,
            );
          if (trial.initial.renderedCount !== test.expected)
            throw Error("Unexpected rendered count");
          if (mode === "manual" && trial.initial.initiallyCreated !== 0)
            throw Error("Manual mode ignored initial OFF");
          if (
            trial.afterMove.renderedCount !== 0 ||
            trial.afterMove.pendingCount !== 0 ||
            trial.afterMove.inactiveCachedCount > 256 ||
            trial.afterMove.inactiveCachedVertices > 50000
          )
            throw Error("Move/cache invariant failed");
          trials.push(trial);
        }
        const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
        const summary = {
          initSyncMs: median(trials.map((t) => t.initial.initSyncMs)),
          readyMs: median(trials.map((t) => t.initial.readyMs)),
          creations: median(trials.map((t) => t.initial.creations)),
          maxLongTaskMs: median(trials.map((t) => t.maxLongTaskMs)),
          moveReadyMs: median(trials.map((t) => t.afterMove.readyMs)),
        };
        if (mode === "manual")
          summary.manualEnableMs = median(trials.map((t) => t.initial.manualEnableMs));
        results.push({ configuration, ...test, mode, summary, trials });
        console.log(
          JSON.stringify({ entry: configuration.label, case: test.name, mode, ...summary }),
        );
      }
    }
  }
  const result = {
    label: "initial-visibility-limit-removal",
    gitHead: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
    source: "worktree",
    browser: browser.version(),
    samples,
    notes:
      "Synthetic geometry. Modules are preloaded; initialization excludes network/JSON transfer and module loading. Editor source is composed from the actual Vite prelude/source lists with a function wrapper for timing. Manual mode uses the current renderer: initial OFF followed by actual visibility-control clicks, representing the old initial-OFF/manual-ON workflow; it is not a measurement of an old Git revision. Another-map layer masks still start OFF; both modes select the same layer after initialization, and readyMs includes that selection. Mobile width/CPU4 is emulation, not a real device. readyMs waits for renderer idle, not GPU paint completion. Long tasks include initialization and pan; heap is indicative.",
    results,
  };
  const output = resolve(root, args.output || "docs/performance/shape-initial-visibility.json");
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(result, null, 2) + "\n");
} finally {
  await browser?.close();
  await server.close();
}
