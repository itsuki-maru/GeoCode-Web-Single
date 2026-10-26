// Reproducible local Chrome/Leaflet/Marked/XSS popup measurements.
// Example: node scripts/measure-popup-content.mjs --label=baseline --output=../../../docs/performance/popup-content-baseline.json --playwright-path=C:/.../playwright/index.mjs
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => arg.replace(/^--/, "").split(/=(.*)/s, 2)),
);
const { chromium } = await import(
  args["playwright-path"] ? pathToFileURL(resolve(args["playwright-path"])).href : "playwright"
);
const samples = Number(args.samples || 3);
const vendors = {
  "/vendor/leaflet.js": "leaflet/dist/leaflet.js",
  "/vendor/leaflet.css": "leaflet/dist/leaflet.css",
  "/vendor/marked.js": "marked/lib/marked.umd.js",
  "/vendor/xss.js": "xss/dist/xss.min.js",
};
const prose = (n) =>
  Array.from(
    { length: n },
    (_, i) =>
      `Paragraph ${i}. This is **formatted text** with a [reference](https://example.test/${i}) and enough words to wrap across several lines.`,
  ).join("\n\n");
const cases = [
  { name: "prose-300", markdown: prose(300) },
  { name: "prose-3000", markdown: prose(3000) },
  {
    name: "prose-3000-tail-details",
    markdown: `${prose(3000)}\n\n:::details Last section\nTail text.\n:::`,
  },
  {
    name: "dated-images-600",
    markdown: Array.from(
      { length: 300 },
      (_, i) =>
        `### Date ${i}\n\n![a](/static/images/${i}-a.svg)\n\n![b](/static/images/${i}-b.svg)`,
    ).join("\n\n"),
  },
  {
    name: "list-3000",
    markdown: Array.from(
      { length: 3000 },
      (_, i) => `- Item ${i} with **strong text** and [a link](https://example.test/${i})`,
    ).join("\n"),
  },
  {
    name: "table-1000x5",
    markdown:
      "|A|B|C|D|E|\n|-|-|-|-|-|\n" +
      Array.from(
        { length: 1000 },
        (_, i) => `|${i}|Text|**Bold**|[Link](https://example.test)|Value|`,
      ).join("\n"),
  },
  {
    name: "paragraph-9000-inline-elements",
    markdown: Array.from(
      { length: 3000 },
      (_, i) => `**bold ${i}** [link](https://example.test/${i}) _emphasis_`,
    ).join(" "),
  },
  {
    name: "raw-html-3000",
    markdown:
      "<div>\n" +
      Array.from(
        { length: 3000 },
        (_, i) =>
          `<p>HTML ${i} <strong>formatted</strong> <a href="https://example.test">link</a></p>`,
      ).join("\n") +
      "\n</div>",
  },
  {
    name: "details-300-closed",
    markdown: Array.from(
      { length: 300 },
      (_, i) => `:::details Section ${i}\n${prose(10)}\n:::`,
    ).join("\n\n"),
  },
  { name: "details-1-long", markdown: `:::details Long body\n${prose(3000)}\n:::`, expand: true },
];

const html = `<!doctype html><html><head><link rel="stylesheet" href="/vendor/leaflet.css"><style>#map{height:700px}.md-detail-contents{width:476px;max-height:500px;overflow:auto}img{width:32px;height:32px}</style><script src="/vendor/leaflet.js"></script><script src="/vendor/marked.js"></script><script src="/vendor/xss.js"></script></head><body><div id="map"></div><script type="module">
import * as content from '/src/map/common/content.ts';
const {createNestedTokenizer,renderIframe,setupDetailsLazyImages,releaseDeferredDetails}=content;
import {installMapMarkdownExtensions} from '/src/map/common/markdown-extensions.ts';
import {installMapMarkdownRenderer} from '/src/map/common/markdown-renderer.ts';
import {createPopupContentRuntime} from '/src/map/common/popup-content.ts';
import {updatePopupLayout} from '/src/map/common/popup-layout.ts';
let phase;
const reset=()=>phase={lexerMs:0,htmlMs:0,sanitizeMs:0,renderMs:0,setupMs:0,domMs:0,domMarkupMs:0,domMutationMs:0,layoutMs:0,updateMs:0,updateCount:0};
const depth={};
const timed=(name,fn)=>function(...args){const outer=!depth[name];depth[name]=(depth[name]||0)+1;const start=performance.now();try{return fn.apply(this,args)}finally{depth[name]--;if(phase&&outer)phase[name]+=performance.now()-start}};
marked.Lexer.prototype.lex=timed('lexerMs',marked.Lexer.prototype.lex);
marked.Lexer.prototype.inlineTokens=timed('lexerMs',marked.Lexer.prototype.inlineTokens);
marked.Parser.prototype.parse=timed('htmlMs',marked.Parser.prototype.parse);
marked.Parser.prototype.parseInline=timed('htmlMs',marked.Parser.prototype.parseInline);
const htmlDescriptor=Object.getOwnPropertyDescriptor(Element.prototype,'innerHTML');
Object.defineProperty(Element.prototype,'innerHTML',{...htmlDescriptor,set:timed('domMarkupMs',htmlDescriptor.set)});
for(const [prototype,method] of [[Node.prototype,'appendChild'],[Node.prototype,'removeChild'],[Element.prototype,'append'],[Element.prototype,'replaceChildren']]) prototype[method]=timed('domMutationMs',prototype[method]);
for(const [method,name] of [['_updateContent','domMs'],['_updateLayout','layoutMs']]) L.Popup.prototype[method]=timed(name,L.Popup.prototype[method]);
const update=L.Popup.prototype.update;
L.Popup.prototype.update=function(...args){if(phase)phase.updateCount++;return timed('updateMs',update).apply(this,args)};
const sanitize=timed('sanitizeMs',html=>renderIframe(filterXSS(html,xssOptions)));
const safe=(text,links)=>{const start=performance.now();try{return content.renderProgressiveMarkdown?content.renderProgressiveMarkdown(text,sanitize,links):sanitize(content.parseMapMarkdown(text,links))}finally{phase.renderMs+=performance.now()-start}};
installMapMarkdownExtensions({marked,extractYouTubeId:()=>null,createNestedTokenizer:type=>createNestedTokenizer(type,{renderDeferredBody:safe})});
const xssOptions=installMapMarkdownRenderer({marked,isLocalhost:()=>false,isPdf:()=>false});
const frames=()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
const round=(value)=>Math.round(value*100)/100;
const snapshot=()=>{const result=Object.fromEntries(Object.entries(phase).map(([key,value])=>[key,round(value)]));result.planningMs=round(Math.max(0,phase.renderMs-phase.lexerMs-phase.htmlMs-phase.sanitizeMs));return result};
let map;
window.measure={
 async run(test){
  if(map)map.remove();document.querySelector('#map').innerHTML='';
  map=L.map('map',{fadeAnimation:false,zoomAnimation:false}).setView([35,139],14);
  const runtime=createPopupContentRuntime({map,renderMarkdown:safe,sanitizeHtml:html=>filterXSS(html,xssOptions),setupImages:timed('setupMs',setupDetailsLazyImages),snapshot:{'marker:test':{body:test.markdown,free_text:test.markdown,managed_markdown:test.markdown,sync_required:false}}});
  reset();const prepareStart=performance.now();const prepared=runtime.render({kind:'marker',id:'test',name:test.name,body:test.markdown});const prepareMs=performance.now()-prepareStart;const prepare=snapshot();
  const marker=L.marker([35,139],{icon:L.divIcon({html:'●'})}).addTo(map).bindPopup(prepared,{maxWidth:600});
  reset();const opened=performance.now();marker.openPopup();const openSyncMs=performance.now()-opened;await frames();const openToFrameMs=performance.now()-opened;
  const root=()=>document.querySelector('.leaflet-popup');
  const result={name:test.name,renderer:content.renderProgressiveMarkdown?'progressive':'legacy',sourceChars:test.markdown.length,preparedHtmlChars:prepared.length,prepareMs:round(prepareMs),prepare,openSyncMs:round(openSyncMs),openToFrameMs:round(openToFrameMs),open:snapshot(),initialElements:root().querySelectorAll('*').length,initialContentElements:root().querySelector('.geocode-content-body')?.querySelectorAll('*').length,initialImages:root().querySelectorAll('img').length};
  if(test.expand){reset();const details=root().querySelector('details');const start=performance.now();details.open=true;details.dispatchEvent(new Event('toggle'));const sync=performance.now()-start;await frames();result.expand={syncMs:round(sync),toFrameMs:round(performance.now()-start),...snapshot(),elements:root().querySelectorAll('*').length}}
  const button=root().querySelector('.geocode-content-load-more,.geocode-image-load-more,.progressive-load-more,[data-load-more]');
  if(button){reset();const start=performance.now();button.click();const sync=performance.now()-start;await frames();result.additional={syncMs:round(sync),toFrameMs:round(performance.now()-start),...snapshot(),elements:root().querySelectorAll('*').length}}
  reset();const updateStart=performance.now();for(let i=0;i<5;i++) marker.getPopup().update();result.cumulativeUpdate5Ms=round(performance.now()-updateStart);
  reset();const appUpdateStart=performance.now();for(let i=0;i<5;i++)updatePopupLayout(marker.getPopup());result.appUpdate5Ms=round(performance.now()-appUpdateStart);result.appUpdate5NativeUpdates=phase.updateCount;
  const appendTrials=[];
  for(let i=0;i<${Number(args["cumulative-batches"] || 10)};i++){
    const more=Array.from(root().querySelectorAll('.geocode-content-load-more,.geocode-image-load-more,.progressive-load-more,[data-load-more]')).find(element=>!element.hidden&&!element.disabled&&!element.closest('details:not([open])'));
    if(!more)break;
    reset();const start=performance.now();more.click();const syncMs=performance.now()-start;await frames();appendTrials.push({syncMs:round(syncMs),...snapshot(),elements:root().querySelectorAll('*').length});
  }
  if(appendTrials.length){reset();const start=performance.now();for(let i=0;i<5;i++)marker.getPopup().update();const update5Ms=performance.now()-start;reset();const appStart=performance.now();for(let i=0;i<5;i++)updatePopupLayout(marker.getPopup());result.cumulative={batches:appendTrials.length,elements:root().querySelectorAll('*').length,lastAppendMs:appendTrials.at(-1).syncMs,update5Ms:round(update5Ms),appUpdate5Ms:round(performance.now()-appStart),appUpdate5NativeUpdates:phase.updateCount,trials:appendTrials}}
  marker.closePopup();releaseDeferredDetails(prepared);return result;
 },
 async budget(markdown,limit){
  if(map){map.remove();map=null}document.querySelector('#map').innerHTML='';reset();
  const lexStart=performance.now();const tokens=marked.lexer(markdown);const lexerMs=performance.now()-lexStart;
  // This fixture has p + strong + a = three rendered elements per paragraph.
  const selected=Object.assign(tokens.slice(0,Math.floor(limit/3)*2),{links:tokens.links});
  const generateStart=performance.now();const markup=filterXSS(marked.parser(selected),xssOptions);const generateMs=performance.now()-generateStart;
  const host=document.createElement('div');host.className='md-detail-contents';const start=performance.now();host.innerHTML=markup;document.querySelector('#map').append(host);host.getBoundingClientRect();const domLayoutMs=performance.now()-start;await frames();
  map=L.map('map',{fadeAnimation:false,zoomAnimation:false}).setView([35,139],14);reset();
  const popupStart=performance.now();L.popup({maxWidth:600}).setLatLng([35,139]).setContent(host).openOn(map);const popupOpenMs=performance.now()-popupStart;await frames();
  return {estimatedElementBudget:limit,lexerMs:round(lexerMs),generateMs:round(generateMs),domLayoutMs:round(domLayoutMs),popupOpenMs:round(popupOpenMs),popupLayoutMs:round(phase.layoutMs),actualElements:host.querySelectorAll('*').length,htmlChars:markup.length};
 }
,lexProbe(markdown){
 const result={};
 for(const [name,skipInline,skipStart] of [['normal',false,false],['blockOnly',true,false],['withoutUnusedBlockStarts',false,true],['blockOnlyWithoutUnusedBlockStarts',true,true]]){
  const options=skipStart?{...marked.defaults,extensions:{...marked.defaults.extensions,startBlock:[]}}:marked.defaults;
  const lexer=new marked.Lexer(options);if(skipInline)lexer.inlineTokens=()=>[];
  const start=performance.now();const tokens=lexer.lex(markdown);result[name]={ms:round(performance.now()-start),blocks:tokens.length};
 }
 return result;
}
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
      name: "popup-measurement",
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
          } else if (url.pathname.startsWith("/static/images/")) {
            res.setHeader("Content-Type", "image/svg+xml");
            res.end(
              '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="navy"/></svg>',
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
  browser = await chromium.launch({ channel: args.browser || "chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
  const errors = [];
  page.on("pageerror", (error) => {
    errors.push(error.message);
    console.error(error.message);
  });
  await page.goto("http://127.0.0.1:" + server.httpServer.address().port + "/measure.html");
  await page.waitForFunction(() => window.ready);
  await page.evaluate((test) => measure.run(test), { name: "warmup", markdown: prose(30) });
  const results = [];
  for (const test of "probe-only" in args || "budgets-only" in args ? [] : cases) {
    const trials = [];
    for (let i = 0; i < samples; i++)
      trials.push(await page.evaluate((test) => measure.run(test), test));
    const median = (path) => {
      const values = trials
        .map((value) => path.split(".").reduce((v, key) => v?.[key], value))
        .filter(Number.isFinite)
        .sort((a, b) => a - b);
      return values.length ? values[Math.floor(values.length / 2)] : undefined;
    };
    const report = {
      name: test.name,
      trials,
      median: {
        prepareMs: median("prepareMs"),
        lexerMs: median("prepare.lexerMs"),
        htmlMs: median("prepare.htmlMs"),
        sanitizeMs: median("prepare.sanitizeMs"),
        planningMs: median("prepare.planningMs"),
        openSyncMs: median("openSyncMs"),
        openToFrameMs: median("openToFrameMs"),
        domMs: median("open.domMs"),
        layoutMs: median("open.layoutMs"),
        updateMs: median("open.updateMs"),
        initialElements: median("initialElements"),
        initialContentElements: median("initialContentElements"),
        initialImages: median("initialImages"),
        expandSyncMs: median("expand.syncMs"),
        expandElements: median("expand.elements"),
        additionalSyncMs: median("additional.syncMs"),
        cumulativeUpdate5Ms: median("cumulativeUpdate5Ms"),
        appUpdate5Ms: median("appUpdate5Ms"),
        appUpdate5NativeUpdates: median("appUpdate5NativeUpdates"),
        cumulativeBatches: median("cumulative.batches"),
        cumulativeElements: median("cumulative.elements"),
        cumulativeLastAppendMs: median("cumulative.lastAppendMs"),
        cumulativeFullUpdate5Ms: median("cumulative.update5Ms"),
        cumulativeAppUpdate5Ms: median("cumulative.appUpdate5Ms"),
        cumulativeAppUpdate5NativeUpdates: median("cumulative.appUpdate5NativeUpdates"),
      },
    };
    results.push(report);
    console.log(JSON.stringify(report.median ? { name: test.name, ...report.median } : report));
  }
  const budgets = [];
  for (const limit of "probe-only" in args ? [] : [100, 200, 400]) {
    const trials = [];
    for (let i = 0; i < samples; i++)
      trials.push(
        await page.evaluate(({ markdown, limit }) => measure.budget(markdown, limit), {
          markdown: prose(3000),
          limit,
        }),
      );
    budgets.push({ limit, trials });
    console.log(JSON.stringify({ budget: limit, trials }));
  }
  const lexerProbes = [];
  for (const test of ("budgets-only" in args ? [] : cases).filter((test) =>
    ["prose-3000", "list-3000", "paragraph-9000-inline-elements"].includes(test.name),
  )) {
    const trials = [];
    for (let i = 0; i < samples; i++)
      trials.push(await page.evaluate((markdown) => measure.lexProbe(markdown), test.markdown));
    lexerProbes.push({ name: test.name, trials });
    console.log(JSON.stringify({ lexerProbe: test.name, trials }));
  }
  if (errors.length) throw Error(errors.join("\n"));
  const report = {
    measurementVersion: 2,
    label: args.label || "measurement",
    recordedAt: new Date().toISOString(),
    browser: await browser.version(),
    viewport: { width: 1000, height: 800 },
    samples,
    notes: [
      "Headless Chrome on this Windows host; not iOS device results.",
      "openToFrameMs is two requestAnimationFrame callbacks after open, not a direct paint measurement.",
      "Phase timers may be nested; updateMs includes DOM and layout timers.",
      "Images are fixed-size local SVGs. Network transfer and image decode are not the target of these measurements.",
      "Budget candidate probe uses prose paragraphs only and generates selected complete tokens, not full hidden DOM.",
    ],
    results,
    budgets,
    lexerProbes,
  };
  if (args.output) {
    const output = resolve(args.output);
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify(report, null, 2) + "\n");
    console.log(JSON.stringify({ output }));
  }
} finally {
  await browser?.close();
  await server.close();
}
