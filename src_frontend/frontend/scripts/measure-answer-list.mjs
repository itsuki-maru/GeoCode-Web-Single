// 本番ビルドの実際の FormAnswersModal を使い、稼働中のバックエンドやネットワーク遅延には依存しない。
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
const table = resolve(appRoot, "src/components/map-object/FormAnswersModal.vue");
const output = resolve(
  root,
  "target/answer-list-benchmark",
  `${mobile ? "mobile" : "pc"}-${stage}`,
);
if (!output.startsWith(resolve(root, "target/answer-list-benchmark") + sep))
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
  define: { "window.ANSWER_STAGE": JSON.stringify(stage) },
  plugins: [
    {
      name: "benchmark-real-table",
      enforce: "pre",
      resolveId(id) {
        if (id.endsWith("/answer-list-benchmark-entry.ts"))
          return resolve(scripts, "answer-list-benchmark-entry.ts");
      },
      async load(id) {
        if (normalize(id) === normalize(table))
          return source.replace(
            "</script>",
            "defineExpose({ setBenchmarkColumns: (keys: string[]) => { displayFields.value = keys; }, benchmarkRowRefs: () => rows.value.map((row) => new WeakRef(row)) });\n</script>",
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
    },
  },
  build: {
    outDir: output,
    emptyOutDir: true,
    rollupOptions: { input: resolve(scripts, "answer-list-performance.html") },
  },
});
// Rollup は、ルート外の HTML 入力を、選択したアプリによって異なるパスに出力する。
const { glob } = await import("node:fs/promises");
let html;
for await (const path of glob("**/answer-list-performance.html", { cwd: output })) html = path;
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
  for (const fieldCount of (args.fields || "5,20,200").split(",").map(Number))
    for (const length of (args.lengths || "80,5000").split(",").map(Number))
      for (let trial = 0; trial < Number(args.samples || 1); ++trial) {
        const context = await browser.newContext({
          viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 800 },
          isMobile: mobile,
          hasTouch: mobile,
        });
        const page = await context.newPage(),
          errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        const cdp = await context.newCDPSession(page);
        await cdp.send("Performance.enable");
        await page.exposeFunction("answerMemoryCheckpoint", async () => {
          await cdp.send("HeapProfiler.collectGarbage");
          const metrics = await cdp.send("Performance.getMetrics");
          return metrics.metrics.find((metric) => metric.name === "JSHeapUsedSize")?.value;
        });
        if (mobile) await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
        await page.goto(`http://127.0.0.1:${server.address().port}/${html.replaceAll("\\", "/")}`);
        await page.waitForFunction(() => typeof window.runAnswerBenchmark === "function");
        const result = await page.evaluate((options) => window.runAnswerBenchmark(options), {
          fieldCount,
          length,
          probe: args.probe === "true",
        });
        if (errors.length) throw Error(errors.join("\n"));
        if (args.probe === "true") {
          await cdp.send("HeapProfiler.collectGarbage");
          await page.evaluate(
            () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
          );
          await cdp.send("HeapProfiler.collectGarbage");
          result.retainedAfterTask = await page.evaluate(
            () => window.closedAnswerRefs.filter((reference) => reference.deref()).length,
          );
          if (result.retainedAfterTask !== (stage === "after" ? 0 : 50))
            throw Error("Unexpected retained answer count after transitions");
          results.push({ stage, mobile, trial, probe: true, ...result });
          console.log(
            JSON.stringify({
              stage,
              mobile,
              retainedAfterTask: result.retainedAfterTask,
              closedRows: result.closedRows,
            }),
          );
          await context.close();
          continue;
        }

        if (
          !result.localNoRequests ||
          result.requests.options !== 4 ||
          result.requests.search !== 5
        )
          throw Error("Unexpected answer request count: " + JSON.stringify(result.requests));
        if (
          result.selectedCells !==
          50 * (stage === "after" && mobile ? Math.min(3, fieldCount) : fieldCount)
        )
          throw Error("Column selection did not apply");
        if (
          stage === "after" &&
          (result.closedRows !== 0 ||
            result.cycles.some((cycle) => cycle.rows !== 0) ||
            (mobile && result.selectedCells !== 150))
        )
          throw Error("Answer presentation invariant failed");
        results.push({ stage, mobile, trial, ...result });
        console.log(
          JSON.stringify({
            stage,
            mobile,
            fieldCount,
            length,
            initialMs: Math.round(result.initialMs),
            selectedCells: result.selectedCells,
            closedRows: result.closedRows,
          }),
        );
        if (args.screenshot && stage === "after") {
          await page.evaluate(() => window.openBenchmarkAnswers());
          await page.screenshot({ path: resolve(args.screenshot), fullPage: false });
        }
        await context.close();
      }
  const report = {
    measuredAt: new Date().toISOString(),
    baseline,
    browser: browser.version(),
    results,
  };
  const reportPath = resolve(
    args.output || `target/answer-list-${mobile ? "mobile" : "pc"}-${stage}.json`,
  );
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  console.log(`Saved ${results.length} trials: ${reportPath}`);
} finally {
  await browser.close();
  await new Promise((done) => server.close(done));
}
