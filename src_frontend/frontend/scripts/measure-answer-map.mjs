// 実際の AnswerMapModal、本番ビルドの地図モジュール、ローカルの読み取り専用 Rust サーバーを使う。
// 生の HTML・データ・スクリーンショットは target/ に保存し、レポートには件数・時間・バイト数のみを含める。
import assert from "node:assert/strict";
import { readFile, mkdir, writeFile, realpath } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { build, loadConfigFromFile } from "vite";
import vue from "@vitejs/plugin-vue";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const scripts = resolve(root, "src_frontend/frontend/scripts");
const args = Object.fromEntries(process.argv.slice(2).map((arg) => arg.replace(/^--/, "").split(/=(.*)/s, 2)));
const output = resolve(root, args.output || "target/answer-map-browser");
const targetRoot = resolve(root, "target") + sep;
if (!output.startsWith(targetRoot)) throw Error("Benchmark output must stay under target/");
const modes = (args.modes || "pc,mobile").split(",");
if (modes.some((mode) => !["pc", "mobile"].includes(mode))) throw Error("Invalid benchmark modes");
const initialOnly = args["initial-only"] === "true";
const expectedCanonicalTextSha256 = args["canonical-text-sha256"] || null;
if (expectedCanonicalTextSha256 && (!/^[a-f0-9]{64}$/.test(expectedCanonicalTextSha256) || initialOnly)) throw Error("Canonical text verification is a separate full functional run");
const bootstrapFormat = args["bootstrap-format"] || "native";
if (!["native", "legacy", "json"].includes(bootstrapFormat)) throw Error("Bootstrap format must be native, legacy or json");
const bootstrapLoader = args["bootstrap-loader"] || (bootstrapFormat === "legacy" ? "legacy" : "current");
if (!["legacy", "current"].includes(bootstrapLoader)) throw Error("Bootstrap loader must be legacy or current");
const memorySampling = args["memory-sampling"] === "true";
const processMemory = args["process-memory"] === "true";
const freshBrowser = args["fresh-browser"] === "true";
const memoryInterval = Number(args["memory-interval"] || 100);
if (!Number.isInteger(memoryInterval) || memoryInterval < 50 || memoryInterval > 1000) throw Error("Memory interval must be 50..1000ms");
const samples = Number(args.samples || 1);
if (!Number.isInteger(samples) || samples < 1 || samples > 20) throw Error("Samples must be 1..20");
const normalize = (path) => path.replaceAll("\\", "/").split("?")[0];
const mark = (name) => `(window as any).__benchmarkMark?.(${JSON.stringify(name)});`;
const boundary = (name) => `(window as any).__benchmarkMarkOnce?.(${JSON.stringify(name)}); (window as any).__benchmarkMemoryBoundary?.(${JSON.stringify(name)});`;
async function privateInput(path) {
  const resolved = await realpath(resolve(root, path));
  if (![targetRoot, resolve(root, "GeoCode-Web-Single/target") + sep].some((folder) => resolved.startsWith(folder))) throw Error("Private diagnostic inputs must stay under a repository target/");
  return resolved;
}
const legacyBootstrapPath = bootstrapLoader === "legacy"
  ? await privateInput(args["legacy-bootstrap"] || "target/answer-map-json/baseline/src_frontend/template-scripts/src/map/bootstrap.ts") : null;
const legacyBootstrapSource = legacyBootstrapPath ? await readFile(legacyBootstrapPath, "utf8") : null;
function instrumentBootstrap(source) {
  source = source.replaceAll("\r\n", "\n");
  source = replaceOnce(source, "export function readMapBootstrap(): MapBootstrap {", "export function readMapBootstrap(): MapBootstrap {\n" + boundary("map.bootstrap.loader.start"), "bootstrap loader");
  const parse = 'value = JSON.parse(node.textContent ?? "");';
  if (source.includes(parse)) {
    source = replaceOnce(source, parse, boundary("map.bootstrap.jsonParse.start") + "\n" + parse + "\n" + boundary("map.bootstrap.jsonParse.end"), "JSON parse");
    source = replaceOnce(source, "  if (jsonNode) {", "  " + boundary("map.bootstrap.validation.end") + "\n  if (jsonNode) {", "bootstrap validation");
    source = replaceOnce(source, "    jsonNode.remove();", "    jsonNode.remove();\n    " + boundary("map.bootstrap.nodeRemoved"), "JSON node removal");
  }
  const restore = "    restoreNormalBodyReferences(value);";
  if (source.includes(restore)) {
    source = replaceOnce(source, restore, "    " + boundary("map.bootstrap.bodyRestore.start") + "\n" + restore + "\n    " + boundary("map.bootstrap.bodyRestore.end"), "normal body restoration");
  }
  return replaceOnce(source, "  return value as unknown as MapBootstrap;", "  " + boundary("map.bootstrap.loader.end") + "\n  return value as unknown as MapBootstrap;", "bootstrap return");
}
function replaceOnce(source, needle, replacement, label) {
  if (!source.includes(needle) || source.indexOf(needle) !== source.lastIndexOf(needle)) throw Error(`Benchmark marker changed: ${label}`);
  return source.replace(needle, replacement);
}
function instrumentModal(source) {
  source = source.replaceAll("\r\n", "\n");
  source = replaceOnce(source, "const submit = async () => {", "const submit = async () => {\n" + mark("parent.submit.start"), "submit");
  source = replaceOnce(source, "const view = await requestCurrentMapView(viewController.signal);", mark("parent.view.request") + "\nconst view = await requestCurrentMapView(viewController.signal);\n" + mark("parent.view.complete"), "map view");
  source = replaceOnce(source, "disposeNativeRequest = submitAuthenticatedForm(form.value, frame.value, (message) => {", mark("parent.nativeSubmit") + "\ndisposeNativeRequest = submitAuthenticatedForm(form.value, frame.value, (message) => {", "native submit");
  source = replaceOnce(source, "if (!scopeReady.value || !props.isOpen || presetModalOpen.value) return;", "if (!scopeReady.value || !props.isOpen || presetModalOpen.value) return;\nif (optionsOnly) { " + mark("parent.options.start") + " }", "options start");
  source = replaceOnce(source, "if (optionsOnly) {\n      busy.value = false;", "if (optionsOnly) {\n      " + mark("parent.options.complete") + "\n      busy.value = false;", "options complete");
  source = replaceOnce(source, 'if (data.type === "answer-map-ready") {', 'if (data.type === "answer-map-ready") {\n' + mark("parent.mapReady.receive"), "ready receive");
  const readyStart = source.indexOf('if (data.type === "answer-map-ready") {');
  const readyEnd = source.indexOf('} else if (data.type === "answer-map-error")', readyStart);
  if (readyStart < 0 || readyEnd < readyStart) throw Error("Ready handler marker changed");
  const readyBody = replaceOnce(source.slice(readyStart, readyEnd), "loading.value = false;", "loading.value = false;\n" + mark("parent.loading.cleared") + "\nvoid nextTick().then(() => requestAnimationFrame(() => requestAnimationFrame(() => { " + mark("parent.loading.paintOpportunity") + " })));", "loading clear");
  source = source.slice(0, readyStart) + readyBody + source.slice(readyEnd);
  return source.replace("</script>", `${stateExpose}\n</script>`);
}
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
const parentEditorPlugin = args["parent-retained-html"]
  ? (await loadConfigFromFile({ command: "build", mode: "production" }, resolve(root, "src_frontend/template-scripts/vite.config.ts"))).config.plugins.find((plugin) => plugin.name === "geocode-editor-entries")
  : null;
if (args["parent-retained-html"] && !parentEditorPlugin) throw Error("Parent editor build plugin unavailable");
for (const mode of modes) {
  const app = resolve(root, "src_frontend", mode === "mobile" ? "frontend-mobile" : "frontend");
  const component = normalize(resolve(app, "src/components/map-object/AnswerMapModal.vue"));
  const mapEntry = normalize(resolve(root, "src_frontend/template-scripts/src/entries/form-answer-map.ts"));
  const printPreview = normalize(resolve(root, "src_frontend/template-scripts/src/map/print/print-preview.ts"));
  const printState = normalize(resolve(root, "src_frontend/template-scripts/src/map/print/answer-print-state.ts"));
  const readOnlyPage = normalize(resolve(root, "src_frontend/template-scripts/src/map/read-only-page.ts"));
  const bootstrapModule = normalize(resolve(root, "src_frontend/template-scripts/src/map/bootstrap.ts"));
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
        resolveId(id) {
          if (parentEditorPlugin && id.startsWith("/src/map/")) return resolve(root, "src_frontend/template-scripts", id.slice(1));
        },
        async load(id) {
          if (parentEditorPlugin && id.startsWith("\0virtual:geocode-editor:")) {
            const source = await parentEditorPlugin.load(id);
            if (typeof source !== "string") throw Error("Parent editor source unavailable");
            return source + `\nwindow.__parentEditorBenchmark = {
              stats: () => shapeRenderManager.getStats(),
              zoom: () => map.getZoom(),
              settle: async () => { await new Promise(requestAnimationFrame); await shapeRenderManager.whenIdle(); await new Promise(requestAnimationFrame); }
            };`;
          }
          if (id.includes("?")) return null;
          const path = normalize(id);
          if (path === bootstrapModule) return instrumentBootstrap(legacyBootstrapSource || await readFile(id, "utf8"));
          if (path === component) return instrumentModal(await readFile(id, "utf8"));
          if (path === mapEntry) {
            let source = await readFile(id, "utf8");
            const marker = 'const runtime = initializeReadOnlyMapPage("form-answer-map");';
            if (!source.includes(marker)) throw Error("Map runtime capture marker changed");
            source = source.replace("const bootstrap = readMapBootstrap();", mark("map.entry.start") + "\nconst bootstrap = readMapBootstrap();\n" + mark("map.bootstrapRead.end") + boundary("map.bootstrapRead.returned"));
            source = source.replace(marker, mark("map.runtime.start") + boundary("map.memory.runtime.start") + "\n" + marker + "\n(window as any).__answerMapRuntime = runtime;\n" + mark("map.runtime.end") + boundary("map.memory.runtime.end"));
            const finish = "finishAnswerPreview(runtime, bootstrap, (window as any).L);";
            source = replaceOnce(source, finish, mark("map.controllers.end") + "\n" + mark("map.finish.start") + "\n" + finish + "\n" + mark("map.finish.end") + '\nruntime.shapeRenderer.whenIdle().then(() => { ' + mark("map.firstIdle") + boundary("map.memory.firstIdle") + '\nrequestAnimationFrame(() => requestAnimationFrame(() => { ' + mark("map.firstIdle.paintOpportunity") + " })); });", "finish preview");
            return source;
          }
          if (path === readOnlyPage) {
            let source = (await readFile(id, "utf8")).replaceAll("\r\n", "\n");
            source = replaceOnce(source, "  shapeRenderer = createShapeRenderManager({", "  " + mark("map.shapeRegister.start") + "\n  shapeRenderer = createShapeRenderManager({", "shape registration start");
            const registered = '  map.on("unload", () => {\n    shapeRenderer.destroy();';
            source = replaceOnce(source, registered, "  " + mark("map.shapeRegister.end") + "\n" + registered, "shape registration end");
            source = replaceOnce(source, "  shapeRenderer.refresh();\n\n  return {", "  " + mark("map.initialRefresh.start") + "\n  shapeRenderer.refresh();\n  " + mark("map.initialRefresh.end") + "\n\n  return {", "initial refresh");
            return source;
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
            // 隔離した読み取り専用サーバーでは、実際の認証やセッションは使わない。
            // 実際の Axios リクエストは維持し、無関係なアプリのルーティングや認証のインポートは省く。
            return 'import axios from "axios"; const client=axios.create({baseURL:"",withCredentials:true}); client.isAxiosError=axios.isAxiosError; export default client;';
          }
        },
      },
      ...(parentEditorPlugin ? [parentEditorPlugin] : []),
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
          ...(parentEditorPlugin ? { "parent-map": `virtual:geocode-editor:${mode === "mobile" ? "map-mobile" : "map"}` } : {}),
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
const parentBackend = new URL(args["parent-backend"] || backend);
if (parentBackend.protocol !== "http:" || parentBackend.hostname !== "127.0.0.1" || !Number(parentBackend.port)) throw Error("A localhost parent diagnostic backend is required");
const manifestPath = resolve(root, args.manifest || "target/answer-map-private/manifest.json");
if (![targetRoot, resolve(root, "GeoCode-Web-Single/target") + sep].some((folder) => manifestPath.startsWith(folder))) throw Error("Private manifest must stay under a repository target/");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const query = manifest.query || { mode: "history" };
const selectedForm = manifest.scenarios?.find((scenario) => scenario.name === "selected_form");
const filledCase = manifest.scenarios?.find((scenario) => scenario.name === "filled");
const harnessOptions = {
  query,
  parentRetained: !!args["parent-retained-html"],
  preferredFormId: selectedForm?.formId,
  preferredFieldId: filledCase?.fieldId,
  preferredFieldType: filledCase?.fieldType,
};
const requests = [];
let activeMode = modes[0];
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#e9edf0"/></svg>';
const handlerTiming = (header) => {
  const match = (header || "").match(/(?:^|,)\s*handler\s*;\s*dur=([0-9]+(?:\.[0-9]+)?)/i);
  return match ? Number(match[1]) : null;
};
const bootstrapKeys = ["page", "popupBodies", "answerPreview", "isCluster", "initialView", "tileServers", "tileOverlays", "tileVisibilityAccountId", "layers", "markers", "shapes"];
const optionalBootstrapKeys = ["normalBodyReferences"];
function bootstrapBlock(html) {
  const jsonOpen = /<script\b(?=[^>]*\bid\s*=\s*["']geocode-map-bootstrap["'])[^>]*>/i.exec(html);
  if (jsonOpen && !/\btype\s*=\s*["']application\/json["']/i.test(jsonOpen[0])) throw Error("Invalid bootstrap JSON script type");
  const assignment = html.indexOf("window.__GEOCODE_MAP_BOOTSTRAP__ =");
  if (!jsonOpen && assignment < 0) return null;
  const format = jsonOpen ? "json" : "legacy";
  const start = jsonOpen ? jsonOpen.index : html.lastIndexOf("<script", assignment);
  const bodyStart = jsonOpen ? jsonOpen.index + jsonOpen[0].length : assignment + "window.__GEOCODE_MAP_BOOTSTRAP__ =".length;
  const end = html.indexOf("</script>", bodyStart);
  if (start < 0 || end < 0) throw Error("Bootstrap script bounds changed");
  return { start, bodyStart, end: end + 9, bodyEnd: end, format };
}
const skipSpace = (source, position) => { while (/\s/.test(source[position] || "") && position < source.length) position++; return position; };
function stringEnd(source, start) {
  for (let position = start + 1; position < source.length; position++) {
    if (source[position] === "\\") position++;
    else if (source[position] === '"') return position + 1;
  }
  throw Error("Unterminated bootstrap JSON string");
}
function valueEnd(source, start) {
  if (source[start] === '"') return stringEnd(source, start);
  if (!["{", "["].includes(source[start])) {
    let end = start;
    while (end < source.length && !/[\s,}\]]/.test(source[end])) end++;
    if (end === start) throw Error("Empty bootstrap value");
    return end;
  }
  const stack = [], tokens = /["{}\[\]]/g;
  tokens.lastIndex = start;
  for (let token; (token = tokens.exec(source));) {
    const char = token[0];
    if (char === '"') tokens.lastIndex = stringEnd(source, token.index);
    else if (char === "{" || char === "[") stack.push(char);
    else {
      if (stack.pop() !== (char === "}" ? "{" : "[")) throw Error("Unbalanced bootstrap JSON value");
      if (!stack.length) return tokens.lastIndex;
    }
  }
  throw Error("Unterminated bootstrap JSON value");
}
function rawBootstrap(html) {
  const block = bootstrapBlock(html);
  if (!block) throw Error("Answer-map bootstrap is required");
  let position = skipSpace(html, block.bodyStart);
  if (html[position++] !== "{") throw Error("Bootstrap object expected");
  const values = new Map();
  while (true) {
    position = skipSpace(html, position);
    if (html[position] === "}") { position++; break; }
    let key;
    if (html[position] === '"') {
      const end = stringEnd(html, position);
      key = JSON.parse(html.slice(position, end));
      position = end;
    } else {
      const token = /[A-Za-z_$][A-Za-z0-9_$]*/y;
      token.lastIndex = position;
      const match = token.exec(html);
      if (!match) throw Error("Bootstrap property expected");
      key = match[0]; position = token.lastIndex;
    }
    if ((!bootstrapKeys.includes(key) && !optionalBootstrapKeys.includes(key)) || values.has(key)) throw Error("Unexpected bootstrap property");
    position = skipSpace(html, position);
    if (html[position++] !== ":") throw Error("Bootstrap colon expected");
    position = skipSpace(html, position);
    const end = valueEnd(html, position);
    let raw = html.slice(position, end);
    // この固定の三つの数値からなるオブジェクトに限り、JS の識別子と末尾のカンマを使う。
    if (key === "initialView" && block.format === "legacy") raw = raw.replace(/\b(latitude|longitude|zoom)\s*:/g, '"$1":').replace(/,\s*}/g, "}");
    values.set(key, raw);
    position = skipSpace(html, end);
    if (html[position] === ",") {
      position++;
      if (block.format === "json" && html[skipSpace(html, position)] === "}") throw Error("Trailing comma in bootstrap JSON");
    }
    else if (html[position] !== "}") throw Error("Bootstrap comma expected");
  }
  position = skipSpace(html, position);
  if (block.format === "legacy") {
    if (html[position++] !== ";") throw Error("Bootstrap terminator expected");
    position = skipSpace(html, position);
  }
  if (position !== block.bodyEnd || bootstrapKeys.some((key) => !values.has(key))
    || values.size > bootstrapKeys.length + optionalBootstrapKeys.length) throw Error("Bootstrap body bounds changed");
  return { block, values };
}
function jsonObjectFields(source) {
  let position = skipSpace(source, 0);
  if (source[position++] !== "{") throw Error("Bootstrap preview object expected");
  const fields = new Map();
  while (true) {
    position = skipSpace(source, position);
    if (source[position] === "}") break;
    if (source[position] !== '"') throw Error("Bootstrap preview property expected");
    const keyEnd = stringEnd(source, position), key = JSON.parse(source.slice(position, keyEnd));
    if (fields.has(key)) throw Error("Duplicate bootstrap preview property");
    position = skipSpace(source, keyEnd);
    if (source[position++] !== ":") throw Error("Bootstrap preview colon expected");
    position = skipSpace(source, position);
    const end = valueEnd(source, position);
    fields.set(key, { start: position, end });
    position = skipSpace(source, end);
    if (source[position] === ",") position++;
    else if (source[position] !== "}") throw Error("Bootstrap preview comma expected");
  }
  return fields;
}
function wrapBootstrap(html, parsed, format, transport) {
  const values = new Map(parsed.values);
  if (transport) {
    let preview = values.get("answerPreview");
    const fields = jsonObjectFields(preview), queryField = fields.get("query");
    if (!queryField || !fields.has("parentOrigin") || !fields.has("requestId")) throw Error("Frozen HTML preview metadata is required");
    const stable = (value) => JSON.stringify(value, (_, nested) => nested && typeof nested === "object" && !Array.isArray(nested) ? Object.fromEntries(Object.keys(nested).sort().map((key) => [key, nested[key]])) : nested);
    if (stable(JSON.parse(preview.slice(queryField.start, queryField.end))) !== stable(JSON.parse(transport.get("query") || "null"))) throw Error("Frozen HTML query must match the benchmark manifest");
    if (transport.get("parent_origin") !== origin || !/^[A-Za-z0-9_-]{1,128}$/.test(transport.get("request_id") || "")) throw Error("Invalid frozen HTML transport metadata");
    if (transport.get("initial_view") || transport.get("analysis")) throw Error("Frozen HTML requires the fixture's initial view and analysis");
    for (const [key, value] of [["parentOrigin", transport.get("parent_origin")], ["requestId", transport.get("request_id")]].sort((a, b) => fields.get(b[0]).start - fields.get(a[0]).start)) {
      const field = fields.get(key);
      preview = preview.slice(0, field.start) + JSON.stringify(value) + preview.slice(field.end);
    }
    values.set("answerPreview", preview);
  }
  const propertyKeys = [...bootstrapKeys, ...optionalBootstrapKeys.filter((key) => values.has(key))];
  const properties = propertyKeys.map((key) => {
    let value = values.get(key);
    if (format === "legacy" && key === "initialView") value = value.replace(/"(latitude|longitude|zoom)"\s*:/g, "$1:");
    return `            ${format === "json" ? JSON.stringify(key) : key}: ${value}`;
  }).join(",\n");
  const script = format === "json"
    ? `<script type="application/json" id="geocode-map-bootstrap" data-benchmark-bootstrap="json">\n        {\n${properties}\n        }\n    </script>`
    : `<script data-benchmark-bootstrap="legacy">\n        window.__GEOCODE_MAP_BOOTSTRAP__ = {\n${properties},\n        };\n    </script>`;
  return html.slice(0, parsed.block.start) + script + html.slice(parsed.block.end);
}
function markBootstrapHtml(html) {
  const block = bootstrapBlock(html);
  if (!block) return html;
  const { start, end, format } = block;
  let script = html.slice(start, end);
  if (!script.includes("data-benchmark-bootstrap=")) script = script.replace("<script", `<script data-benchmark-bootstrap="${format}"`);
  // スクリプトを分ける必要がある。大きなスクリプト内に計測点を置くと、実行されるのは
  // エンジンがオブジェクトリテラル全体を解析・コンパイルした後になる。
  return html.slice(0, start)
    + `<script>window.__benchmarkBootstrapFormat=${JSON.stringify(format)};window.__benchmarkMark?.("map.bootstrap.beforeScript");window.__benchmarkMemoryBoundary?.("map.bootstrap.beforeScript");</script>`
    + script
    + '<script>window.__benchmarkMark?.("map.bootstrap.afterScript");window.__benchmarkMemoryBoundary?.("map.bootstrap.afterScript");</script>'
    + html.slice(end);
}
const fixturePath = args["map-html"] ? await privateInput(args["map-html"]) : null;
const fixtureHtml = fixturePath ? await readFile(fixturePath, "utf8") : null;
const fixtureParsed = fixtureHtml ? rawBootstrap(fixtureHtml) : null;
const fixtureSha256 = fixtureHtml ? createHash("sha256").update(fixtureHtml).digest("hex") : null;
const parentRecordsPath = args["parent-retained-html"] ? await privateInput(args["parent-retained-html"]) : null;
const parentRecordsHtml = parentRecordsPath ? await readFile(parentRecordsPath, "utf8") : null;
const parentRecordsParsed = parentRecordsHtml ? rawBootstrap(parentRecordsHtml) : null;
if (parentRecordsParsed?.values.has("normalBodyReferences")) throw Error("Parent diagnostic records must be canonical full-body data");
const parentRecordsBody = parentRecordsParsed ? Buffer.from(`{"markers":${parentRecordsParsed.values.get("markers")},"shapes":${parentRecordsParsed.values.get("shapes")}}`) : null;
const parentRecordsHash = parentRecordsHtml ? createHash("sha256").update(parentRecordsHtml).digest("hex") : null;
if (parentRecordsBody && fixtureHtml) throw Error("Parent coexistence uses live answer-map HTML with inherited view");
if (fixtureHtml && args["write-prototype-html"] === "true") {
  for (const format of ["legacy", "json"]) await writeFile(resolve(output, `private-bootstrap-${format}.html`), wrapBootstrap(fixtureHtml, fixtureParsed, format));
}
const server = createServer(async (request, response) => {
  const receivedAt = performance.now();
  try {
    if (request.headers.host !== new URL(origin).host) return response.writeHead(403).end();
    const url = new URL(request.url, "http://localhost");
    if (request.headers.origin && request.headers.origin !== origin) return response.writeHead(403).end();
    if (url.pathname === "/__bench-parent-records") {
      if (!parentRecordsBody || request.method !== "GET") return response.writeHead(404).end();
      response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      response.end(parentRecordsBody);
      return;
    }
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
    if (url.pathname.startsWith("/form-answers/") || url.pathname.startsWith("/assets/") || url.pathname === "/profile/parent-map") {
      const chunks = [];
      let bytes = 0;
      for await (const chunk of request) {
        bytes += chunk.length;
        if (bytes > 1024 * 1024) return response.writeHead(413).end();
        chunks.push(chunk);
      }
      const start = performance.now();
      const replay = !!fixtureHtml && url.pathname === "/form-answers/map";
      const useParentBackend = url.pathname === "/profile/parent-map" || (parentRecordsBody && url.pathname.startsWith("/assets/"));
      const upstream = replay ? { status: 200, ok: true, headers: new Headers({ "content-type": "text/html; charset=utf-8" }) } : await fetch(new URL(url.pathname + url.search, useParentBackend ? parentBackend : backend), {
        method: request.method,
        headers: {
          ...(request.headers["content-type"] ? { "content-type": request.headers["content-type"] } : {}),
          ...(request.headers.origin ? { origin: request.headers.origin } : {}),
          ...(url.pathname === "/profile/parent-map" && request.headers["user-agent"] ? { "user-agent": request.headers["user-agent"] } : {}),
        },
        body: ["GET", "HEAD"].includes(request.method) ? undefined : Buffer.concat(chunks),
        redirect: "manual",
      });
      const headersAt = performance.now();
      let body = replay ? null : Buffer.from(await upstream.arrayBuffer());
      const bodyAt = performance.now();
      const contentType = upstream.headers.get("content-type") || "application/octet-stream";
      let decodeMs = 0, rewriteMs = 0, encodeMs = 0, bootstrapTransformMs = 0;
      if (contentType.includes("text/html")) {
        const decodeStart = performance.now();
        let html = replay ? fixtureHtml : body.toString("utf8");
        const rewriteStart = performance.now();
        decodeMs = rewriteStart - decodeStart;
        if (url.pathname === "/form-answers/map" && (replay || bootstrapFormat !== "native")) {
          const transformStart = performance.now();
          const parsed = replay ? fixtureParsed : rawBootstrap(html);
          html = wrapBootstrap(html, parsed, bootstrapFormat === "native" ? parsed.block.format : bootstrapFormat,
            replay ? new URLSearchParams(Buffer.concat(chunks).toString("utf8")) : null);
          bootstrapTransformMs = performance.now() - transformStart;
        }
        html = html.replaceAll('src="/assets/template-form-answer-map.js"', `src="/__bench/${activeMode}/map.js"`)
          .replaceAll('src="/assets/template-form-answer-map-print.js"', `src="/__bench/${activeMode}/print.js"`);
        if (url.pathname === "/profile/parent-map") html = html
          .replaceAll('src="/assets/template-map.js"', `src="/__bench/${activeMode}/parent-map.js"`)
          .replaceAll('src="/assets/template-map-mobile.js"', `src="/__bench/${activeMode}/parent-map.js"`);
        if (url.pathname === "/form-answers/map") html = markBootstrapHtml(html);
        const encodeStart = performance.now();
        rewriteMs = encodeStart - rewriteStart;
        body = Buffer.from(html);
        encodeMs = performance.now() - encodeStart;
      }
      let item;
      if (url.pathname.startsWith("/form-answers/")) {
        const endpoint = ["/form-answers/map", "/form-answers/map-filter", "/form-answers/map-print", "/form-answers/map-csv-check"].includes(url.pathname) ? url.pathname : "/form-answers/other";
        item = {
          endpoint, status: upstream.status, requestBytes: bytes, responseBytes: body.length,
          responseSource: replay ? "frozen-html" : "live-backend",
          serverHandlerMs: handlerTiming(upstream.headers.get("server-timing")),
          proxy: {
            requestReadMs: start - receivedAt,
            upstreamHeadersMs: replay ? null : headersAt - start,
            upstreamBodyMs: replay ? null : bodyAt - headersAt,
            bootstrapTransformMs,
            htmlDecodeMs: decodeMs, htmlRewriteMs: rewriteMs, htmlEncodeMs: encodeMs,
            responseStartMs: null, responseSendMs: null, responseEndMs: null,
          },
        };
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
      const responseStartedAt = performance.now();
      if (item) {
        item.proxyMs = responseStartedAt - start;
        item.proxy.responseStartMs = responseStartedAt - receivedAt;
      }
      const headers = { "content-type": contentType, "cache-control": "no-store" };
      const timing = upstream.headers.get("server-timing");
      if (timing) headers["server-timing"] = timing;
      response.writeHead(upstream.status, headers).end(body, () => {
        if (item) {
          item.proxy.responseSendMs = performance.now() - responseStartedAt;
          item.proxy.responseEndMs = performance.now() - receivedAt;
        }
      });
      return;
    }
    // すべての地図タイル、非公開のアイコン・画像 URL、ポップアップのメディアにローカルの代替データを使う。
    response.writeHead(200, { "content-type": "image/svg+xml" }).end(svg);
  } catch {
    response.writeHead(500).end("Benchmark proxy failed");
  }
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${server.address().port}`;
const { chromium } = await import(args["playwright-path"] ? pathToFileURL(resolve(args["playwright-path"])).href : "playwright");
const execFileAsync = promisify(execFile);
async function browserProcessMemory(session) {
  const started = performance.now();
  if (process.platform !== "win32") return { available: false, reason: "windows_only" };
  if (!session) return { available: false, reason: "browser_cdp_unavailable" };
  try {
    // PID の取得元はブラウザー単位の CDP のみとする。Windows プロセスを名前で列挙したり、
    // 他のブラウザーやアプリのコマンドラインを照会したりしない。
    const information = await session.send("SystemInfo.getProcessInfo");
    const entries = information.processInfo;
    if (!Array.isArray(entries) || !entries.length || entries.some((entry) => typeof entry.id !== "number" || !Number.isSafeInteger(entry.id) || entry.id < 1 || entry.id > 0xffffffff)) {
      return { available: false, reason: "invalid_browser_process_ids", probeWallMs: performance.now() - started };
    }
    const ids = [...new Set(entries.map((entry) => entry.id))];
    // 固定の非対話コマンドには、検証済みの十進整数だけを渡す。
    // Get-Process には明示的な ID を渡し、全プロセスの走査は行わない。
    const command = `
$ErrorActionPreference = 'Stop'
$answerMapRequestedPids = @(${ids.join(",")})
$answerMapProcesses = @(Get-Process -Id $answerMapRequestedPids -ErrorAction SilentlyContinue)
if ($answerMapProcesses.Count -eq 0) { throw 'Browser processes unavailable' }
$answerMapPrivateCommit = [long]0
$answerMapWorkingSets = [long]0
foreach ($answerMapProcess in $answerMapProcesses) {
  $answerMapPrivateCommit += [long]$answerMapProcess.PrivateMemorySize64
  $answerMapWorkingSets += [long]$answerMapProcess.WorkingSet64
}
[pscustomobject]@{ processCount = $answerMapProcesses.Count; privateCommitBytes = $answerMapPrivateCommit; sumWorkingSetBytes = $answerMapWorkingSets } | ConvertTo-Json -Compress
`;
    const powershell = resolve(process.env.SystemRoot || "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe");
    const { stdout } = await execFileAsync(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], {
      windowsHide: true, timeout: 10000, maxBuffer: 64 * 1024, encoding: "utf8",
    });
    const value = JSON.parse(stdout.replace(/^\uFEFF/, "").trim());
    if (!Number.isInteger(value.processCount) || value.processCount < 1 || value.processCount > ids.length
      || !Number.isSafeInteger(value.privateCommitBytes) || value.privateCommitBytes < 0
      || !Number.isSafeInteger(value.sumWorkingSetBytes) || value.sumWorkingSetBytes < 0) {
      return { available: false, reason: "invalid_process_memory_result", probeWallMs: performance.now() - started };
    }
    return {
      available: true, processCount: value.processCount, requestedProcessCount: ids.length,
      missingProcessCount: ids.length - value.processCount,
      privateCommitBytes: value.privateCommitBytes, sumWorkingSetBytes: value.sumWorkingSetBytes,
      probeWallMs: performance.now() - started,
    };
  } catch {
    // PowerShell や CDP のエラーテキストには端末情報が含まれる場合があるため、ログに出力しない。
    return { available: false, reason: "process_memory_snapshot_failed", probeWallMs: performance.now() - started };
  }
}
const launchBrowser = () => chromium.launch({ channel: "chrome", headless: true, args: memorySampling ? ["--enable-precise-memory-info"] : [] });
let browser = await launchBrowser();
const results = [];
const timeout = Number(args.timeout || 120000);
let failed = false;
try {
  for (const mode of modes) for (let sample = 0; sample < samples; sample++) {
    if (freshBrowser && results.length) {
      await browser.close();
      browser = await launchBrowser();
    }
    let processSession = null;
    if (processMemory) {
      try { processSession = await browser.newBrowserCDPSession(); } catch { /* 任意のチェックポイント診断 */ }
    }
    const mobile = mode === "mobile";
    const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 800 }, isMobile: mobile, hasTouch: mobile, reducedMotion: "no-preference",
      ...(parentRecordsBody && mobile ? { userAgent: `Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${browser.version()} Mobile Safari/537.36` } : {}),
    });
    let blockedExternalRequests = 0, pageErrors = 0;
    await context.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.origin === origin || ["data:", "blob:", "about:"].includes(url.protocol)) return route.continue();
      blockedExternalRequests++;
      if (route.request().resourceType() === "image") return route.fulfill({ contentType: "image/svg+xml", body: svg });
      return route.abort();
    });
    await context.addInitScript(({ sampleMemory }) => {
      window.__benchmarkMilestones = {};
      window.__benchmarkMark = (name) => {
        const at = performance.now();
        window.__benchmarkMilestones[name] = { at, epoch: performance.timeOrigin + at };
        performance.mark(name);
      };
      window.__benchmarkMarkOnce = (name) => {
        if (!window.__benchmarkMilestones[name]) window.__benchmarkMark(name);
      };
      window.__benchmarkBootstrapDom = () => {
        const jsonNode = document.getElementById("geocode-map-bootstrap");
        const nodes = new Set(document.querySelectorAll("script[data-benchmark-bootstrap]"));
        if (jsonNode) nodes.add(jsonNode);
        let textCodeUnits = 0;
        for (const node of nodes) for (const child of node.childNodes) if (child instanceof CharacterData) textCodeUnits += child.length;
        return {
          format: ["legacy", "json"].includes(window.__benchmarkBootstrapFormat) ? window.__benchmarkBootstrapFormat : null,
          scriptNodes: nodes.size, jsonNodePresent: !!jsonNode, textCodeUnits,
          globalSnapshotPresent: window.__GEOCODE_MAP_BOOTSTRAP__ !== undefined,
        };
      };
      window.__benchmarkMemoryBoundaries = {};
      if (sampleMemory) window.__benchmarkMemoryBoundary = (name) => {
        if (window.__benchmarkMemoryBoundaries[name]) return;
        const memory = performance.memory;
        window.__benchmarkMemoryBoundaries[name] = {
          at: performance.now(), epoch: performance.timeOrigin + performance.now(),
          performanceMemoryAvailable: !!memory,
          ...(memory ? { usedJsHeapBytes: memory.usedJSHeapSize, totalJsHeapBytes: memory.totalJSHeapSize, jsHeapLimitBytes: memory.jsHeapSizeLimit } : {}),
          bootstrapDom: window.__benchmarkBootstrapDom(),
        };
      };
      window.__benchmarkLongTasks = [];
      try {
        new PerformanceObserver((list) => {
          window.__benchmarkLongTasks.push(...list.getEntries().map((entry) => ({ at: performance.timeOrigin + entry.startTime, ms: entry.duration })));
        }).observe({ type: "longtask", buffered: true });
      } catch { /* 任意のブラウザー診断 */ }
    }, { sampleMemory: memorySampling });
    const page = await context.newPage();
    page.on("pageerror", () => { pageErrors++; });
    const cdp = await context.newCDPSession(page);
    await cdp.send("Performance.enable");
    if (mobile) await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
    const result = {
      mode, sample: sample + 1, initialOnly, bootstrapFormat, bootstrapLoader, frozenHtml: !!fixtureHtml, memorySampling, processMemory,
      conditions: { freshBrowserContext: true, freshPage: true, freshBrowserProcess: freshBrowser || results.length === 0, firstSampleInMode: sample === 0, browserReused: !freshBrowser && results.length > 0, backendAndOsCachesReset: false, preciseMemoryInfoFlag: memorySampling },
      viewport: mobile ? [390, 844] : [1280, 800], cpuRate: mobile ? 4 : 1, phases: [], cycles: [],
    };
    const performanceMetrics = async () => {
      const snapshot = await cdp.send("Performance.getMetrics");
      const allowed = new Set(["TaskDuration", "ScriptDuration", "LayoutDuration", "RecalcStyleDuration", "DevToolsCommandDuration", "V8CompileDuration", "TaskOtherDuration", "ThreadTime", "ProcessTime", "JSHeapUsedSize", "JSHeapTotalSize", "LayoutCount", "RecalcStyleCount"]);
      return Object.fromEntries(snapshot.metrics.filter((metric) => allowed.has(metric.name)).map((metric) => [metric.name, metric.value]));
    };
    const heap = async () => {
      await cdp.send("HeapProfiler.collectGarbage");
      const metrics = await cdp.send("Performance.getMetrics");
      return metrics.metrics.find((item) => item.name === "JSHeapUsedSize")?.value ?? null;
    };
    const memorySnapshot = async () => {
      const [metrics, dom] = await Promise.all([performanceMetrics(), cdp.send("Memory.getDOMCounters")]);
      return {
        jsHeapUsedBytes: metrics.JSHeapUsedSize ?? null, jsHeapTotalBytes: metrics.JSHeapTotalSize ?? null,
        documents: dom.documents, nodes: dom.nodes, jsEventListeners: dom.jsEventListeners,
      };
    };
    const startMemorySampling = () => {
      if (!memorySampling) return null;
      let running = true;
      const aggregate = { intervalMs: memoryInterval, samples: 0, failedSamples: 0, probeWallMs: 0, maxima: {} };
      const started = performance.now();
      const pending = (async () => {
        while (running) {
          const probe = performance.now();
          try {
            const value = await memorySnapshot();
            aggregate.samples++;
            for (const [key, number] of Object.entries(value)) if (typeof number === "number") aggregate.maxima[key] = Math.max(aggregate.maxima[key] || 0, number);
          } catch { aggregate.failedSamples++; }
          aggregate.probeWallMs += performance.now() - probe;
          if (running) await new Promise((done) => setTimeout(done, memoryInterval));
        }
      })();
      return { async stop() { running = false; await pending; return { ...aggregate, elapsedMs: performance.now() - started }; } };
    };
    let initialMemorySampler = null;
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
      const finishedAt = Date.now();
      const entry = { name, ms: performance.now() - started, requests: requests.slice(firstRequest) };
      if (name === "initial") entry.cdpAtReady = await performanceMetrics();
      if (frame) {
        entry.map = await frame.evaluate(() => window.__answerMapRuntimeBenchmark.counts());
        entry.modal = await page.evaluate(() => window.__answerMapBenchmark.state());
      }
      const tasks = [];
      for (const current of page.frames()) {
        try { tasks.push(...await current.evaluate(({ start, end }) => (window.__benchmarkLongTasks || []).filter((item) => item.at >= start && item.at < end).map((item) => item.ms), { start: startedAt, end: finishedAt })); } catch { /* 切り離されたフレーム */ }
      }
      entry.longTasks = { count: tasks.length, maxMs: Math.max(0, ...tasks), totalMs: tasks.reduce((sum, ms) => sum + ms, 0) };
      result.phases.push(entry);
      console.log(JSON.stringify({ mode, sample: sample + 1, phase: name, ms: Math.round(entry.ms), pending: entry.map?.pendingCount ?? null, rendered: entry.map?.renderedCount ?? null, logicalShapes: entry.map?.logicalVisibleShapes ?? null }));
      return entry;
    };
    try {
      await page.goto(`${origin}/benchmark.html?mode=${mode}`);
      await page.waitForFunction(() => !!window.__answerMapBenchmark);
      if (parentRecordsBody) {
        await page.waitForFunction(() => {
          const state = window.__answerMapBenchmark.parentState();
          return state.ready || state.failed;
        }, null, { timeout });
        result.parentRetained = await page.evaluate(() => window.__answerMapBenchmark.parentState());
        assert.equal(result.parentRetained.failed, false, "Parent diagnostic setup must succeed");
        assert.equal(result.parentRetained.shapes, manifest.shapes, "Parent raw cache must retain the same shapes");
        const parentFrame = page.frames().find((frame) => frame.url().includes("/profile/parent-map"));
        assert.ok(parentFrame, "Parent editor iframe must exist");
        await parentFrame.waitForFunction(() => window.__parentEditorBenchmark?.zoom() === 16, null, { timeout });
        await parentFrame.evaluate(() => window.__parentEditorBenchmark.settle());
        await parentFrame.waitForFunction(() => window.__parentEditorBenchmark.stats().pendingCount === 0 && document.querySelectorAll(".leaflet-overlay-pane svg path").length > 0, null, { timeout });
        result.parentRetained.editor = await parentFrame.evaluate(() => ({
          page: window.__GEOCODE_MAP_BOOTSTRAP__?.page,
          shapes: window.__GEOCODE_MAP_BOOTSTRAP__?.shapes?.length,
          svgPaths: document.querySelectorAll(".leaflet-overlay-pane svg path").length,
          pendingCount: window.__parentEditorBenchmark.stats().pendingCount,
          generatedShapes: window.__parentEditorBenchmark.stats().renderedCount,
          zoom: window.__parentEditorBenchmark.zoom(),
        }));
        assert.equal(result.parentRetained.editor.shapes, manifest.shapes);
        assert.equal(result.parentRetained.editor.page, mobile ? "map-mobile" : "map", "Parent editor must use the matching device implementation");
      }
      result.heapBeforeOpen = await heap();
      result.memoryBeforeOpen = await memorySnapshot();
      if (processMemory) result.processMemoryBeforeOpen = await browserProcessMemory(processSession);
      const initialCdpBefore = await performanceMetrics();
      initialMemorySampler = startMemorySampling();
      await phase("initial", async () => {
        await page.evaluate(() => window.__answerMapBenchmark.open());
        await page.waitForFunction(() => !!document.querySelector(".map-state .spinner"), null, { timeout });
        result.loadingIndicator = await page.evaluate(() => {
          const container = document.querySelector(".map-state");
          const spinner = container?.querySelector(".spinner");
          const style = spinner ? getComputedStyle(spinner) : null;
          const box = spinner?.getBoundingClientRect();
          const durations = (style?.animationDuration || "").split(",").map((value) => parseFloat(value) * (value.trim().endsWith("ms") ? 1 : 1000));
          return {
            observedDuringRequest: !!window.__answerMapBenchmark.state().loading,
            present: !!spinner, visible: !!box && box.width > 0 && box.height > 0,
            inline: !!spinner?.closest(".progress-inline"),
            fullScreenOverlay: !!spinner?.closest(".progress-overlay,.overlay-progress-bar"),
            messageUnchanged: !!container?.textContent?.includes("地図を読み込んでいます…"),
            animationName: style?.animationName || "none", animationDurationMs: durations,
          };
        });
      });
      if (initialMemorySampler) {
        result.initialMemorySampling = await initialMemorySampler.stop();
        initialMemorySampler = null;
      }
      const initial = result.phases.at(-1);
      assert.equal(result.loadingIndicator.present && result.loadingIndicator.visible && result.loadingIndicator.inline && result.loadingIndicator.messageUnchanged && result.loadingIndicator.observedDuringRequest, true, "Inline spinner must be visible while the real request is pending");
      assert.equal(result.loadingIndicator.fullScreenOverlay, false);
      assert.notEqual(result.loadingIndicator.animationName, "none");
      const frameAtReady = await ready();
      // 時間計測のフィールドだけを取得する。NavigationTiming.name、URL、リソース名、
      // DOM テキスト、初期化オブジェクト、オブジェクト識別子は出力しない。
      const childTiming = await frameAtReady.evaluate(() => {
        const navigation = performance.getEntriesByType("navigation")[0];
        const fields = ["startTime", "fetchStart", "requestStart", "responseStart", "responseEnd", "domInteractive", "domContentLoadedEventStart", "domContentLoadedEventEnd", "loadEventStart", "loadEventEnd", "transferSize", "encodedBodySize", "decodedBodySize", "redirectCount"];
        return {
          timeOrigin: performance.timeOrigin,
          navigation: Object.fromEntries(fields.filter((field) => typeof navigation?.[field] === "number").map((field) => [field, navigation[field]])),
          serverHandlerMs: navigation?.serverTiming?.find((entry) => entry.name === "handler")?.duration ?? null,
          marks: window.__benchmarkMilestones || {},
          memoryBoundaries: window.__benchmarkMemoryBoundaries || {},
        };
      });
      const parentTiming = await page.evaluate(() => ({
        timeOrigin: performance.timeOrigin, marks: window.__benchmarkMilestones || {},
        optionsRequests: performance.getEntriesByType("resource")
          .filter((entry) => { try { return new URL(entry.name).pathname === "/form-answers/map-filter"; } catch { return false; } })
          .map((entry) => ({ startTime: entry.startTime, requestStart: entry.requestStart, responseStart: entry.responseStart, responseEnd: entry.responseEnd, duration: entry.duration, transferSize: entry.transferSize, encodedBodySize: entry.encodedBodySize, decodedBodySize: entry.decodedBodySize })),
      }));
      const openedAt = parentTiming.marks["parent.open.start"]?.epoch;
      const combined = { ...parentTiming.marks, ...childTiming.marks };
      const markOffsetsMs = Object.fromEntries(Object.entries(combined).map(([name, value]) => [name, value.epoch - openedAt]));
      const between = (start, end) => combined[start] && combined[end] ? combined[end].epoch - combined[start].epoch : null;
      const cdpDeltas = Object.fromEntries(Object.entries(initial.cdpAtReady || {})
        .filter(([name]) => typeof initialCdpBefore[name] === "number")
        .map(([name, value]) => [name, value - initialCdpBefore[name]]));
      result.initialDiagnostics = {
        navigation: childTiming.navigation,
        navigationSpansMs: {
          ttfb: childTiming.navigation.responseStart - childTiming.navigation.requestStart,
          responseBody: childTiming.navigation.responseEnd - childTiming.navigation.responseStart,
          requestToResponseEnd: childTiming.navigation.responseEnd - childTiming.navigation.requestStart,
        },
        navigationOffsetsMs: Object.fromEntries(["requestStart", "responseStart", "responseEnd", "domInteractive", "domContentLoadedEventEnd", "loadEventEnd"].filter((name) => childTiming.navigation[name] > 0).map((name) => [name, childTiming.timeOrigin + childTiming.navigation[name] - openedAt])),
        serverHandlerMs: childTiming.serverHandlerMs,
        markOffsetsMs,
        spansMs: {
          mapViewRequest: between("parent.view.request", "parent.view.complete"),
          bootstrapSeparateScripts: between("map.bootstrap.beforeScript", "map.bootstrap.afterScript"),
          bootstrapLoaderSynchronous: between("map.bootstrap.loader.start", "map.bootstrap.loader.end"),
          bootstrapJsonParse: between("map.bootstrap.jsonParse.start", "map.bootstrap.jsonParse.end"),
          bootstrapBodyRestore: between("map.bootstrap.bodyRestore.start", "map.bootstrap.bodyRestore.end"),
          runtimeSynchronous: between("map.runtime.start", "map.runtime.end"),
          shapeRegistration: between("map.shapeRegister.start", "map.shapeRegister.end"),
          initialRefreshSynchronous: between("map.initialRefresh.start", "map.initialRefresh.end"),
          finishPreviewSynchronous: between("map.finish.start", "map.finish.end"),
          readyMessageDelay: between("map.finish.end", "parent.mapReady.receive"),
          optionsAfterReady: between("parent.mapReady.receive", "parent.options.complete"),
          optionsRequestAndApply: between("parent.options.start", "parent.options.complete"),
          shapeIdleAfterRuntime: between("map.runtime.end", "map.firstIdle"),
        },
        optionsRequests: parentTiming.optionsRequests,
        cdpDeltas,
        cdpDurationUnits: "seconds; heap units bytes; LayoutCount/RecalcStyleCount are counts",
      };
      result.memoryAtInitialReady = {
        beforeForcedGc: await memorySnapshot(),
        bootstrapDom: await frameAtReady.evaluate(() => window.__benchmarkBootstrapDom()),
        boundaries: childTiming.memoryBoundaries,
      };
      if (processMemory) result.memoryAtInitialReady.processBeforeForcedGc = await browserProcessMemory(processSession);
      await cdp.send("HeapProfiler.collectGarbage");
      result.memoryAtInitialReady.afterForcedGc = await memorySnapshot();
      if (processMemory) result.memoryAtInitialReady.processAfterForcedGc = await browserProcessMemory(processSession);
      const memoryBoundaryValues = Object.values(childTiming.memoryBoundaries);
      result.memoryAtInitialReady.boundaryObservedMaxUsedJsHeapBytes = memoryBoundaryValues.length
        ? Math.max(0, ...memoryBoundaryValues.map((value) => value.usedJsHeapBytes || 0)) : null;
      assert.equal(result.memoryAtInitialReady.bootstrapDom.globalSnapshotPresent, true, "Validated bootstrap must remain available to runtime/print");
      if (result.memoryAtInitialReady.bootstrapDom.format === "json") {
        assert.equal(result.memoryAtInitialReady.bootstrapDom.jsonNodePresent, false, "JSON source DOM must be released");
        assert.equal(result.memoryAtInitialReady.bootstrapDom.textCodeUnits, 0, "No raw JSON script text may remain attached");
      } else assert.ok(result.memoryAtInitialReady.bootstrapDom.textCodeUnits > 0, "Legacy inline source remains in the document");
      delete initial.cdpAtReady;
      assert.ok(initial.modal.initialCount > 10000, "Real benchmark needs more than 10000 targets");
      assert.equal(initial.map.recordCount, initial.modal.initialCount, "Fixture contains shapes only");
      assert.equal(initial.map.mobileControls, mobile);
      if (!initialOnly) {
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
            // 印刷の準備完了条件に合わせる。閉じたポップアップの details 内の画像は意図的に
            // 遅延読み込みするため、待機中のリソースには数えない。
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
      }
      if (expectedCanonicalTextSha256) {
        await phase("canonicalTextVerification", async () => {
          const frame = await ready();
          result.canonicalTextVerification = await frame.evaluate(async () => {
            const bootstrap = window.__GEOCODE_MAP_BOOTSTRAP__;
            if (Object.hasOwn(bootstrap, "normalBodyReferences")) throw Error("Unrestored diagnostic snapshot");
            const rows = [];
            const push = (kind, id, body) => {
              const popup = bootstrap.popupBodies[`${kind}:${id}`];
              if (typeof body !== "string" || !popup || typeof popup.free_text !== "string" || typeof popup.managed_markdown !== "string" || typeof popup.sync_required !== "boolean") throw Error("Canonical diagnostic text invalid");
              rows.push([`${kind}:${id}`, body, popup.free_text, popup.managed_markdown, popup.sync_required]);
            };
            for (const marker of Object.values(bootstrap.markers)) push("marker", marker.id, marker.detail);
            for (const shape of bootstrap.shapes) push("shape", shape.id, shape.geojson?.properties?.memo);
            rows.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
            const encoded = new TextEncoder().encode(JSON.stringify(rows));
            const digest = await crypto.subtle.digest("SHA-256", encoded);
            return { records: rows.length, sha256: Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("") };
          });
          assert.equal(result.canonicalTextVerification.sha256, expectedCanonicalTextSha256, "Every restored normal/free/all-answer body and sync flag must match the frozen full-data baseline");
          result.canonicalTextVerification.matchesBaseline = true;
        }, false);
      }
      result.heapOpenAfterOperations = await heap();
      if (processMemory && !initialOnly) result.processMemoryAfterOperations = await browserProcessMemory(processSession);
      const cycles = initialOnly ? 1 : Number(args.cycles || 3);
      for (let cycle = 0; cycle < cycles; cycle++) {
        await phase(`close${cycle + 1}`, () => page.evaluate(() => window.__answerMapBenchmark.close()), false);
        await page.waitForTimeout(100);
        const closedHeap = await heap();
        const closedMemory = await memorySnapshot();
        const retained = await page.evaluate(() => window.__answerMapBenchmark.retainedRuntimes());
        result.cycles.push({ cycle: cycle + 1, closedHeap, closedMemory, retainedRuntimes: retained, iframeCount: await page.locator("iframe:not(#map-iframe)").count(), parentIframeCount: await page.locator("#map-iframe").count() });
        if (processMemory) result.cycles.at(-1).processMemory = await browserProcessMemory(processSession);
        assert.equal(result.cycles.at(-1).iframeCount, 0, "Closing must remove all map frames");
        assert.equal(result.cycles.at(-1).parentIframeCount, parentRecordsBody ? 1 : 0, "Parent editor retention must match the diagnostic mode");
        assert.equal(retained, 0, "Closed runtime must be collectable after GC");
        if (cycle < cycles - 1) await phase(`reopen${cycle + 1}`, () => page.evaluate(() => window.__answerMapBenchmark.open()));
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
      if (initialMemorySampler) await initialMemorySampler.stop();
      results.push(result);
      await context.close();
      if (processSession) await processSession.detach().catch(() => {});
    }
  }
  const report = {
    measuredAt: new Date().toISOString(), browser: browser.version(),
    initialOnly, samplesPerMode: samples,
    bootstrapComparison: {
      requestedFormat: bootstrapFormat, requestedLoader: bootstrapLoader, responseSource: fixtureHtml ? "frozen-html" : "live-backend",
      frozenHtmlSha256: fixtureSha256, frozenHtmlBytes: fixtureHtml ? Buffer.byteLength(fixtureHtml) : null,
      frozenHtmlSourceFormat: fixtureParsed?.block.format || null,
      frozenBootstrapSectionCount: fixtureParsed?.values.size || null,
      frozenHasNormalBodyReferences: fixtureParsed ? fixtureParsed.values.has("normalBodyReferences") : null,
      legacyLoaderSha256: legacyBootstrapSource ? createHash("sha256").update(legacyBootstrapSource).digest("hex") : null,
      explicitBaselineLoaderOverride: !!legacyBootstrapSource && !!args["legacy-bootstrap"],
      memorySampling, memorySamplingIntervalMs: memorySampling ? memoryInterval : null,
      processMemoryCheckpoints: processMemory, freshBrowserPerSample: freshBrowser,
      privatePrototypeHtmlWritten: !!fixtureHtml && args["write-prototype-html"] === "true",
      parentEditorAndRawPiniaRetained: !!parentRecordsBody,
      parentCanonicalSourceHtmlSha256: parentRecordsHash,
      expectedCanonicalTextSha256,
    },
    dataset: { answers: manifest.answers, targets: manifest.targets, markers: manifest.markers, shapes: manifest.shapes, htmlBytes: manifest.htmlBytes },
    sourceSha256: Object.fromEntries(await Promise.all([
      "src_frontend/frontend/src/components/map-object/AnswerMapModal.vue",
      "src_frontend/frontend-mobile/src/components/map-object/AnswerMapModal.vue",
      "src_frontend/frontend/src/components/common/ProgressSpinner.vue",
      "src_frontend/frontend-mobile/src/components/common/ProgressSpinner.vue",
      "src_frontend/template-scripts/src/map/read-only-page.ts",
      "src_frontend/template-scripts/src/map/bootstrap.ts",
      "src_frontend/template-scripts/src/map/normal-body-references.ts",
      "src/templates/form-answer-map.html",
      "src_frontend/template-scripts/src/map/common/shape-renderer.ts",
      "src_frontend/template-scripts/src/map/answer-filter.ts",
      "src_frontend/template-scripts/src/map/answer-coloring.ts",
      "src_frontend/template-scripts/src/map/print/answer-print-state.ts",
      "src_frontend/frontend/scripts/answer-map-benchmark-entry.ts",
    ].map(async (path) => [path, createHash("sha256").update(await readFile(resolve(root, path))).digest("hex")]))),
    results,
    notes: [
      "Production-built real PC/mobile AnswerMapModal, map/filter/color/print modules; benchmark-only expose/runtime captures are injected at build time.",
      fixtureHtml
        ? "Initial map HTML is replayed from one private immutable HTML file; the backend map handler is excluded from initial timing and serverHandlerMs is null. Only parentOrigin/requestId are patched for the current frame; query/as_of must match. Filter, CSV and print still use real read-only HTTP endpoints. Original 1MiB request cap remains."
        : "Uses real read-only Rust map, map-filter and map-print HTTP endpoints through a localhost proxy. Original 1MiB request cap is retained.",
      "External requests are blocked; tiles/icons/media are local placeholders. Network tile latency and real authentication are excluded.",
      "Raw HTML/geometry/answer contents remain local; reports contain only aggregate counts, timings and byte sizes.",
      "PC 1280x800; mobile 390x844 with CPU4x emulation, not a physical mobile device. The real fixture contains shapes, not a large marker population.",
      parentRecordsBody
        ? "Optional coexistence mode mounts the actual PC/mobile editor MapIframe, real Pinia stores seeded with the same snapshot records, and focuses one shape before measurement. Setup is excluded; parent/cache stay mounted after closing the answer map. The surrounding full MapView/application UI, real authentication and physical-device memory are not measured. Its inherited parent view differs from isolated full-extent trials; compare only within the same mode."
        : "The ordinary parent editing map and Pinia raw-record store are not mounted concurrently. This does not guarantee whole-application or physical-device memory usage.",
      "Logical visible targets are independent from generated Leaflet objects and SVG DOM counts; all are reported separately.",
      "Operation timings include endpoint work, HTTP/JSON, Vue, iframe rendering and settling plus automation coordination. Do not add them to backend-only measurements.",
      "Heap values are Chrome JS heap after forced GC, not full browser/process memory. Long tasks may be observed by both same-process frame contexts.",
      "Full print may be normally rejected by the retained 32MiB byte cap; successful bounded print uses an actual legend mask of at most1000 targets.",
      "With --initial-only=true, each sample still performs the actual native form/iframe navigation (using either live or explicitly replayed HTML), real automatic initial options request, combined UI/shape readiness and collection after closing; full interaction phases are skipped only in that diagnostic mode.",
      "Each sample uses a fresh context/page. There is no unrecorded warmup. Chrome is reused unless --fresh-browser=true explicitly closes/relaunches it before every subsequent sample. Already-started backend and OS caches are not reset, including in fresh-browser mode. Contexts isolate browser HTTP caches, and proxy API/assets are no-store.",
      "Live initial response is fully buffered by the proxy, decoded, rewritten and encoded before forwarding. Frozen mode skips upstream fetch/decode. bootstrapTransformMs is a subset of htmlRewriteMs. Proxy work is diagnostic overhead; response-send completion is a Node socket callback, not browser responseEnd.",
      "Rewrapping preserves each original section's value text, including optional raw normalBodyReferences, and changes only wrapper/property identifiers, fixed initialView syntax and navigation metadata. Node does not expand body references or parse the full bootstrap. Eleven canonical fields plus the optional sidecar are allowed.",
      "--bootstrap-loader=legacy selects frozen baseline source independently of HTML format; --legacy-bootstrap may point to the pre-codec JSON loader as well as the original global-only loader. The selected baseline hash and explicit-override flag are recorded. Current uses the product source. Baseline files are target-only and loaded at the original bootstrap.ts module location.",
      "Separate beforeScript/afterScript marks surround either the legacy inline JavaScript object literal or the inert application/json text block. Legacy span includes compile/evaluation; json span excludes later JSON.parse. Both may overlap HTML transfer/parser waiting. bootstrapJsonParse measures the actual synchronous JSON.parse call; bootstrapLoaderSynchronous includes its validation/cache/removal. These spans overlap and are not pure exclusive CPU attribution.",
      "parent.mapReady.receive / parent.loading.cleared are the application's ready signal and do not wait for renderer idle; actual receive/idle ordering is shown by the milestones. Automatic options complete later. Paint-opportunity marks are double-rAF scheduling boundaries, not proof that every object pixel was painted.",
      "initial ms preserves the existing combined benchmark criterion: parent scope/options/color-fieldset readiness plus renderer idle and frame settling. Nested spans overlap and must not be added together. CDP duration deltas are renderer/target aggregates and include automation overhead; they are not exact exclusive attribution of iframe JavaScript parsing.",
      "Spinner probes inspect only the fixed loading message, inline/visible booleans and CSS animation properties. Reduced motion is explicitly no-preference for this UI check; normal application reduced-motion behavior is unchanged.",
      "memoryAtInitialReady snapshots occur after the recorded ready timing; one forced GC then measures retained open heap before full interactions. CDP heap/DOM counters cover the target/renderer scope, not total Chrome RSS, all process memory, GPU or server memory. Attached bootstrap text is counted as UTF-16 code units, never exported.",
      "Optional memory-sampling runs use --enable-precise-memory-info, periodic CDP counters and fixed in-page performance.memory boundaries before/after parse, removal, runtime and idle. Only maxima/counts and fixed boundary aggregates are stored. These are observed maxima, can miss peaks and include natural GC/automation; they are not true instantaneous peak memory. Compare speed with sampling disabled in a separate run.",
      "bootstrapBodyRestore and its fixed memory boundaries cover the product normal-body restoration call before validation/cache/publication. The loader span contains parse/restoration/validation/removal, so these are not additive exclusive CPU intervals. Sidecar values/IDs and decoded bodies are never exported.",
      "--process-memory=true adds Windows checkpoint probes only: before opening, before/after the ready-state forced GC, and after closing/GC. Browser-scoped CDP SystemInfo.getProcessInfo supplies validated positive PIDs; hidden noninteractive PowerShell queries only those IDs. Other Chrome/app processes are not enumerated. Missing/exited processes are counted; failed probes return available:false. No per-process IDs or command lines are reported.",
      "Windows privateCommitBytes sums PrivateMemorySize64 (private committed allocation, resident or paged), while sumWorkingSetBytes sums WorkingSet64 (resident private plus shared pages). The working-set sum can count a shared page multiple times and is not unique Chrome RSS/physical memory. Checkpoints are sequential, non-atomic observations rather than peak values; PowerShell latency is recorded and probes run after ready timing, never inside the 100ms sampler. Use separate memory runs; default speed runs disable process probes and fresh-browser mode.",
    ],
  };
  await writeFile(resolve(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ modes: modes.length, samplesPerMode: samples, trials: results.length, completed: results.filter((item) => item.completed).length }));
} finally {
  await browser.close();
  await new Promise((done) => server.close(done));
}
if (failed) process.exitCode = 1;
