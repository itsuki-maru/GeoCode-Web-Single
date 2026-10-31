// 実際の Leaflet/SVG を計測する。--revision=<git ref> で指定したリビジョンのソースを
// Vite 経由で読み込むため、同じテストデータで HEAD と作業ツリーを比較できる。
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => arg.replace(/^--/, "").split(/=(.*)/s, 2)),
);
if ("compare" in args) {
  const base = process.argv
    .slice(2)
    .filter(
      (arg) =>
        !/^--(compare|with-mobile|baseline-revision|revision|label|output|mobile|cpu-rate)(=|$)/.test(
          arg,
        ),
    );
  const configurations = [
    { label: "baseline", revision: args["baseline-revision"] || "HEAD" },
    { label: "after" },
    ...("with-mobile" in args
      ? [
          { label: "mobile-baseline", revision: args["baseline-revision"] || "HEAD", mobile: true },
          { label: "mobile-after", mobile: true },
        ]
      : []),
  ];
  for (const test of configurations) {
    const extra = [
      "--label=" + test.label,
      "--output=docs/performance/shape-rendering-" + test.label + ".json",
    ];
    if (test.revision) extra.push("--revision=" + test.revision);
    if (test.mobile) extra.push("--mobile=true", "--cpu-rate=4");
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(import.meta.url), ...base, ...extra],
      { cwd: root, stdio: "inherit" },
    );
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
  process.exit(0);
}
const samples = Math.max(1, Number(args.samples || 3));
const viewport = args.mobile ? { width: 390, height: 844 } : { width: 1024, height: 768 };
const cpuRate = Math.max(1, Number(args["cpu-rate"] || 1));
const revision = args.revision
  ? execFileSync("git", ["rev-parse", args.revision], { cwd: root, encoding: "utf8" }).trim()
  : null;
const { chromium } = await import(
  args["playwright-path"] ? pathToFileURL(resolve(args["playwright-path"])).href : "playwright"
);
const sourceRoot = resolve(root, "src_frontend/template-scripts/src").replaceAll("\\", "/");
const sourceCache = new Map();
const vendors = {
  "/vendor/leaflet.js": "leaflet/dist/leaflet.js",
  "/vendor/leaflet.css": "leaflet/dist/leaflet.css",
  "/vendor/cluster.js": "leaflet.markercluster/dist/leaflet.markercluster.js",
  "/vendor/marked.js": "marked/lib/marked.umd.js",
  "/vendor/xss.js": "xss/dist/xss.min.js",
};
const cases = [
  { name: "spread-400-z14", count: 400, zoom: 14, vertices: 2 },
  { name: "spread-2000-z14", count: 2000, zoom: 14, vertices: 2 },
  { name: "spread-10000-z14", count: 10000, zoom: 14, vertices: 2 },
  { name: "dense-2000-z5", count: 2000, zoom: 5, vertices: 2, dense: true },
  { name: "spread-2000-v100-z14", count: 2000, zoom: 14, vertices: 100 },
];

const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/vendor/leaflet.css"><style>html,body{margin:0}#map{width:100vw;height:100vh}.leaflet-control{font:12px sans-serif}</style><script src="/vendor/leaflet.js"></script><script src="/vendor/cluster.js"></script><script src="/vendor/marked.js"></script><script src="/vendor/xss.js"></script></head><body><div id="map"></div><script type="module">
import {initializeReadOnlyMapPage} from '/src/map/read-only-page.ts';
let runtime;
const longTasks=[];
try{new PerformanceObserver(list=>longTasks.push(...list.getEntries().map(e=>({start:e.startTime,duration:e.duration})))).observe({type:'longtask',buffered:false})}catch{}
const frames=()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
const round=n=>Math.round(n*100)/100;
const info=()=>({layers:Object.keys(runtime.shapeLayers).length,paths:document.querySelectorAll('#map svg path').length,...(runtime.shapeRenderer?.getStats()||{})});
let creations=0,createMs=0;
const original=L.geoJSON;
L.geoJSON=function(...args){const start=performance.now();try{creations++;return original.apply(this,args)}finally{createMs+=performance.now()-start}};
window.measureShapes=async function(test){
 if(runtime){runtime.map.remove();runtime=null}document.querySelector('#map').innerHTML='';localStorage.clear();
 const shapes=Array.from({length:test.count},(_,i)=>{
  const near=test.dense||i<80;
  const latitude=(near?35.68:34.69)+(i%20)*.0002;
  const longitude=(near?139.76:135.5)+((Math.floor(i/20)%100)*.0002);
  const coordinates=Array.from({length:test.vertices},(_,j)=>[longitude+.001*j/(test.vertices-1),latitude+.0001*Math.sin(j)]);
  return {id:'s-'+i,layer_id:'a',shape_type:'polyline',name:'',user_id:'benchmark',geojson:{type:'Feature',properties:{style:{color:'#2468ac',weight:3,arrowType:i%5===0?'end':'none'}},geometry:{type:'LineString',coordinates}}};
 });
 window.__GEOCODE_MAP_BOOTSTRAP__={page:'form-answer-map',isCluster:false,tileServers:{'1':{id:1,label:'blank',layer_name:'blank',url:'/blank/{z}/{x}/{y}.png',attribution:'benchmark',include_foreign_tiles:true,min_zoom:0,max_zoom:20}},tileOverlays:[],initialView:{latitude:35.681,longitude:139.765,zoom:test.zoom},layers:{a:{id:'a',user_id:'benchmark',layer_name:'pipes',is_master:false}},markers:{},shapes,answerPreview:{query:{},targets:shapes.map(s=>'shape:'+s.id),answerCount:test.count,targetCount:test.count,parentOrigin:location.origin,requestId:'measure'}};
 await frames();creations=0;createMs=0;longTasks.length=0;
 const start=performance.now();
 runtime=initializeReadOnlyMapPage('form-answer-map');
 const initSyncMs=performance.now()-start;
 await runtime.shapeRenderer?.whenIdle();
 const readyMs=performance.now()-start;
 await frames();
 const initial={initSyncMs:round(initSyncMs),readyMs:round(readyMs),toNextFramesMs:round(performance.now()-start),creations,createMs:round(createMs),...info()};
 const moves=[];
 for(const [lat,lng,zoom] of [[35.685,139.77,14],[34.692,135.508,14],[35.681,139.765,14],[35.681,139.765,5],[35.681,139.765,14]]){
  const before=creations;
  const moved=performance.now();runtime.map.setView([lat,lng],zoom,{animate:false});
  const syncMs=performance.now()-moved;
  await runtime.shapeRenderer?.whenIdle();const updateMs=performance.now()-moved;
  await frames();moves.push({latitude:lat,longitude:lng,zoom,syncMs:round(syncMs),updateMs:round(updateMs),created:creations-before,...info()});
 }
 await frames();
 const end=performance.now();
 const overlapping=longTasks.filter(t=>t.start+t.duration>start&&t.start<=end);
 const result={initial,moves,totalCreations:creations,longTaskCount:overlapping.length,maxLongTaskMs:round(Math.max(0,...overlapping.map(t=>t.duration))),heapBytes:performance.memory?.usedJSHeapSize??null};
 runtime.map.remove();runtime=null;return result;
};window.ready=true;
</script></body></html>`;

const server = await createServer({
  root: resolve(root, "src_frontend/template-scripts"),
  configFile: false,
  publicDir: false,
  logLevel: "error",
  server: { host: "127.0.0.1", port: 0 },
  plugins: [
    {
      name: "shape-render-measurement",
      enforce: "pre",
      load(id) {
        const path = id.split("?")[0].replaceAll("\\", "/");
        if (!revision || !path.startsWith(sourceRoot + "/") || !path.endsWith(".ts")) return;
        if (!sourceCache.has(path))
          sourceCache.set(
            path,
            execFileSync(
              "git",
              ["show", revision + ":" + relative(root, path).replaceAll("\\", "/")],
              { cwd: root, encoding: "utf8" },
            ),
          );
        return sourceCache.get(path);
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
  const address = server.httpServer.address();
  const results = [];
  for (const test of cases.filter((test) => !args.case || test.name.includes(args.case))) {
    const trials = [];
    for (let i = 0; i < samples; i++) {
      const page = await browser.newPage({
        viewport,
        ...(args.mobile ? { isMobile: true, hasTouch: true } : {}),
      });
      if (cpuRate > 1)
        await (
          await page.context().newCDPSession(page)
        ).send("Emulation.setCPUThrottlingRate", { rate: cpuRate });
      page.on("pageerror", (error) => console.error(error.message));
      await page.goto(
        `http://127.0.0.1:${address.port}/measure.html${args.mobile ? "?map_ui=mobile" : ""}`,
      );
      await page.waitForFunction(() => window.ready);
      trials.push(await page.evaluate((test) => window.measureShapes(test), test));
      await page.close();
    }
    if (!revision) {
      for (const trial of trials) {
        const expected = test.dense ? 0 : Math.min(80, test.count);
        if (trial.initial.creations !== expected)
          throw Error(test.name + ": unexpected eager creation count");
        for (const move of trial.moves) {
          if (move.inactiveCachedCount > 256 || move.inactiveCachedVertices > 50000)
            throw Error(test.name + ": inactive cache exceeded its budget");
        }
      }
    }
    const median = (key) =>
      [...trials.map((t) => t.initial[key])].sort((a, b) => a - b)[Math.floor(trials.length / 2)];
    const summary = {
      initSyncMs: median("initSyncMs"),
      readyMs: median("readyMs"),
      creations: median("creations"),
      paths: median("paths"),
    };
    results.push({ ...test, summary, trials });
    console.log(JSON.stringify({ case: test.name, ...summary }));
  }
  const result = {
    label: args.label || "worktree",
    revision: revision || "worktree",
    browser: browser.version(),
    samples,
    viewport,
    mobileEmulation: Boolean(args.mobile),
    cpuRate,
    notes:
      "Synthetic geometry; network/JSON transfer excluded. Mobile/CPU emulation is not a real device measurement. readyMs waits for queued generation, toNextFramesMs is not a GPU paint-completion measurement. Heap includes page/runtime data and is indicative only.",
    cases: results,
  };
  if (args.output) {
    const path = resolve(root, args.output);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(result, null, 2) + "\n");
  }
} finally {
  await browser?.close();
  await server.close();
}
