// 本番ビルドの実際の Vue/Pinia テーブルを使い、必要に応じて実際の Leaflet 描画も使う。
import { execFileSync } from "node:child_process";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, resolve, sep, extname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "vite";
import vue from "@vitejs/plugin-vue";
const root = fileURLToPath(new URL("../../../", import.meta.url));
const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => arg.replace(/^--/, "").split(/=(.*)/s, 2)),
);
const stage = args.stage || "after",
  mobile = args.mobile === "true";
if (!["before", "after"].includes(stage)) throw Error("stage must be before/after");
const appRoot = resolve(root, "src_frontend", mobile ? "frontend-mobile" : "frontend");
const scripts = resolve(root, "src_frontend/frontend/scripts");
const table = resolve(appRoot, "src/components/map-object/MapObjectTable.vue");
const index = resolve(appRoot, "src/components/map-object/BenchmarkIndex.vue");
const output = resolve(root, "target/map-table-benchmark", `${mobile ? "mobile" : "pc"}-${stage}`);
if (!output.startsWith(resolve(root, "target/map-table-benchmark") + sep))
  throw Error("Unsafe build path");
const baseline = execFileSync("git", ["rev-parse", args.baseline || "HEAD"], {
  cwd: root,
  encoding: "utf8",
}).trim();
const source =
  stage === "before"
    ? execFileSync(
        "git",
        ["show", `${baseline}:${table.slice(root.length).replaceAll("\\", "/")}`],
        { cwd: root, encoding: "utf8" },
      )
    : await readFile(table, "utf8");
const normalize = (value) => value.replaceAll("\\", "/");
await build({
  configFile: false,
  root: resolve(root, "src_frontend/frontend"),
  base: "/",
  logLevel: "error",
  publicDir: false,
  define: { "window.TABLE_STAGE": JSON.stringify(stage) },
  plugins: [
    {
      name: "benchmark-real-table",
      enforce: "pre",
      resolveId(id) {
        if (id.endsWith("/table-benchmark-entry.ts"))
          return resolve(scripts, "table-benchmark-entry.ts");
      },
      async load(id) {
        if (normalize(id) === normalize(table)) return source;
        if (normalize(id) === normalize(index))
          return (
            source.slice(0, source.indexOf("<template>")) +
            `<template><div>{{ ${stage === "before" ? "tableRows.length" : "count"} }}</div></template>` +
            source.slice(source.indexOf("<style"))
          );
      },
    },
    vue(),
  ],
  resolve: {
    dedupe: ["vue", "pinia"],
    alias: {
      "@": resolve(appRoot, "src"),
      "@bench-component": table,
      "@bench-index": index,
      "@bench-leaflet": resolve(
        root,
        "src_frontend/frontend/node_modules/leaflet/dist/leaflet-src.esm.js",
      ),
      "@bench-leaflet-css": resolve(
        root,
        "src_frontend/frontend/node_modules/leaflet/dist/leaflet.css",
      ),
      "@bench-renderer": resolve(
        root,
        "src_frontend/template-scripts/src/map/common/shape-renderer.ts",
      ),
    },
  },
  build: {
    outDir: output,
    emptyOutDir: true,
    rollupOptions: { input: resolve(scripts, "map-table-performance.html") },
  },
});
// Rollup は、ルート外の HTML 入力を、選択したアプリによって異なるパスに出力する。
const { glob } = await import("node:fs/promises");
let html;
for await (const path of glob("**/map-table-performance.html", { cwd: output })) html = path;
if (!html) throw Error("Missing benchmark HTML");
const server = createServer(async (request, response) => {
  try {
    const path = resolve(output, "." + new URL(request.url, "http://localhost").pathname);
    if (!path.startsWith(output + sep)) {
      response.writeHead(403).end();
      return;
    }
    const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
    response.setHeader("Content-Type", types[extname(path)] || "application/octet-stream");
    response.end(await readFile(path));
  } catch {
    response.writeHead(404).end();
  }
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const { chromium } = await import(pathToFileURL(resolve(args["playwright-path"])).href);
const browser = await chromium.launch({ channel: "chrome", headless: true });
const results = [];
try {
  const modes = (args.modes || "table").split(",");
  for (const count of (args.counts || "2000,20000,40000").split(",").map(Number))
    for (const vertices of (args.vertices || "2,16").split(",").map(Number))
      for (const mode of modes)
        for (let trial = 0; trial < Number(args.samples || 1); ++trial) {
          const context = await browser.newContext({
            viewport: {
              width: Number(args.width || (mobile ? 390 : 1280)),
              height: Number(args.height || (mobile ? 844 : 800)),
            },
            isMobile: mobile,
            hasTouch: mobile,
          });
          const page = await context.newPage();
          const errors = [];
          page.on("pageerror", (error) => errors.push(error.message));
          const cdp = await context.newCDPSession(page);
          await cdp.send("Performance.enable");
          await page.exposeFunction("tableMemoryCheckpoint", async () => {
            await cdp.send("HeapProfiler.collectGarbage");
            const metrics = await cdp.send("Performance.getMetrics");
            return metrics.metrics.find((metric) => metric.name === "JSHeapUsedSize")?.value;
          });
          if (mobile) await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
          await page.goto(
            `http://127.0.0.1:${server.address().port}/${html.replaceAll("\\", "/")}`,
          );
          await page.waitForFunction(() => typeof window.runTableBenchmark === "function");
          const result = await page.evaluate((options) => window.runTableBenchmark(options), {
            count,
            vertices,
            mode,
            mobile,
            initialOnly: args["initial-only"] === "true",
          });
          if (errors.length) throw Error(errors.join("\n"));
          if (stage === "after" && mode === "table") {
            await page.evaluate(async () => {
              const area = document.querySelector(".table-area");
              const row = document.querySelector(".object-row");
              if (Math.abs(row.getBoundingClientRect().height - 56) > 0.5)
                throw Error("Virtual row height drift");
              area.scrollTop = area.scrollHeight;
              area.dispatchEvent(new Event("scroll"));
              await new Promise((done) => requestAnimationFrame(done));
            });
            const lastKey = await page
              .locator("[data-row-key]")
              .last()
              .getAttribute("data-row-key");
            if (lastKey !== `shape:${String(count - 1).padStart(6, "0")}`)
              throw Error(`Virtual bottom lost: ${lastKey}`);
            result.bottomVerified = true;
            if (args.screenshot) {
              await page.locator(".table-area").evaluate((area) => {
                area.scrollTop = 0;
                area.dispatchEvent(new Event("scroll"));
              });
              await page.evaluate(() => new Promise((done) => requestAnimationFrame(done)));
            }
          }
          await cdp.send("HeapProfiler.collectGarbage");
          const metrics = await cdp.send("Performance.getMetrics");
          result.heapBytes = metrics.metrics.find(
            (metric) => metric.name === "JSHeapUsedSize",
          )?.value;
          result.dom = await cdp.send("Memory.getDOMCounters");
          results.push({ stage, mobile, count, vertices, mode, trial, ...result });
          console.log(
            JSON.stringify({
              stage,
              mobile,
              count,
              vertices,
              mode,
              trial,
              readyMs: Math.round(result.allReadyMs),
              rows: result.initialRows,
            }),
          );
          if (args.screenshot && mode === "table")
            await page.screenshot({ path: resolve(args.screenshot), fullPage: false });
          await context.close();
        }
  const report = {
    measuredAt: new Date().toISOString(),
    baseline,
    browser: browser.version(),
    results,
  };
  const reportPath = resolve(
    args.output || `target/map-table-${mobile ? "mobile" : "pc"}-${stage}.json`,
  );
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  console.log(`Saved ${results.length} trials: ${reportPath}`);
} finally {
  await browser.close();
  await new Promise((done) => server.close(done));
}
