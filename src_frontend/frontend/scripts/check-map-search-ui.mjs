// UI確認用のVite fixture。実データを使わず、実コンポーネントをブラウザーで表示する。
// node scripts/check-map-search-ui.mjs
// /map-search-ui.html?view=search|pc-search|mobile-search|answer|panels|list&mobile=1
// &template=1 で別画面地図の共通Markdown CSSも読み込む。
// ?width=390&height=844 を付けると、その幅のiframeでレスポンシブ表示を確認できる。
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import vue from "@vitejs/plugin-vue";

const frontend = fileURLToPath(new URL("../", import.meta.url));
const root = resolve(frontend, "../..");
const beforeDir = resolve(root, "target/map-search-ui");
await mkdir(beforeDir, { recursive: true });
for (const variant of ["frontend", "frontend-mobile"]) {
  const source = execFileSync(
    "git",
    ["show", `f977ed9:src_frontend/${variant}/src/components/map-object/AnswerColoringPanel.vue`],
    { cwd: root, encoding: "utf8" },
  );
  await writeFile(resolve(beforeDir, `${variant}.vue`), source);
}
const moduleUrl = (path) => `/@fs/${path.replaceAll("\\", "/")}`;
const formId = "00000000-0000-0000-0000-000000000001";
const fields = [
  { id: "years", label: "耐用年数", field_type: "number", choices: [] },
  { id: "status", label: "点検状況", field_type: "select", choices: ["点検済み", "要対応"] },
];
const condition = { field_id: "years", field_type: "number", op: "gte", value: "50", upper: null };
const specification = {
  common_form_id: formId,
  rules: [
    { id: "rule1", label: "耐用年数50年以上", color: "#d73027", conditions: [condition] },
    {
      id: "rule2",
      label: "耐用年数20年以上",
      color: "#2166ac",
      conditions: [{ ...condition, value: "20" }],
    },
  ],
};
let nextId = 3;
const preset = (kind, name, definition, id) => ({
  id,
  name,
  kind,
  definition,
  schema_version: 1,
  create_at: "2026-11-02T00:00:00Z",
  display: { form_label: "設備点検", fields },
});
const presets = [
  preset("filter", "50年以上の設備", { common_form_id: formId, conditions: [condition] }, "saved1"),
  preset("coloring", "耐用年数による分類", specification, "saved2"),
];
const fixture = `<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{margin:0;font-family:Arial,sans-serif;background:#e5edf0}#panels{display:flex;gap:24px;padding:24px;align-items:start}#panels>section{width:320px;flex-shrink:0;background:whitesmoke}#panels h2{font-size:16px;margin:12px}#output{padding:16px}iframe.responsive{display:block;border:0;margin:0 auto}</style>
<div id="app"></div><output id="output" aria-label="地図への適用状況">検索0回・色分け0回</output>
<script type="module">
import {createApp,h,ref,onMounted,nextTick} from 'vue';
import {createPinia} from 'pinia';
import Pc from '/src/components/map-object/AnswerColoringPanel.vue';
import Mobile from '${moduleUrl(resolve(frontend, "../frontend-mobile/src/components/map-object/AnswerColoringPanel.vue"))}';
import Before from '${moduleUrl(resolve(beforeDir, "frontend.vue"))}';
import BeforeMobile from '${moduleUrl(resolve(beforeDir, "frontend-mobile.vue"))}';
import List from '/src/components/map-object/SavedMapPresetsModal.vue';
import MobileList from '${moduleUrl(resolve(frontend, "../frontend-mobile/src/components/map-object/SavedMapPresetsModal.vue"))}';
import Answer from '/src/components/map-object/AnswerMapModal.vue';
import MobileAnswer from '${moduleUrl(resolve(frontend, "../frontend-mobile/src/components/map-object/AnswerMapModal.vue"))}';
import MobileMapAnalysisFixture from '/scripts/MobileMapAnalysisFixture.vue';
import PcMapAnalysisFixture from '/scripts/PcMapAnalysisFixture.vue';
import {createAdvancedMapSearchModal,attributeTransport} from '${moduleUrl(resolve(frontend, "../template-scripts/src/map/common/advanced-map-search.ts"))}';
const params=new URLSearchParams(location.search),mobile=params.has('mobile'),view=params.get('view')||'search';
const specification=${JSON.stringify(specification)},fields=${JSON.stringify(fields)},formId=${JSON.stringify(formId)};
if(params.has('width')) {
  const frame=document.createElement('iframe'); frame.className='responsive'; frame.title='狭い画面の確認'; frame.style.width=params.get('width')+'px';frame.style.height=(params.get('height')||844)+'px';
  params.delete('width');params.delete('height');frame.src='/map-search-ui.html?'+params;document.body.replaceChildren(frame);
} else if(view==='mobile-search'||view==='pc-search') {
  await import('${moduleUrl(resolve(frontend, "../frontend-mobile/src/assets/base.css"))}');
  document.querySelector('#output').remove();
  createApp(view==='mobile-search'?MobileMapAnalysisFixture:PcMapAnalysisFixture).use(createPinia()).mount('#app');
} else if(view==='search') {
  let applied=null,colors=null,coloring=null,searches=0,applications=0;
  const report=()=>document.querySelector('#output').textContent='検索'+searches+'回・色分け'+applications+'回';
  const pause=()=>new Promise(done=>setTimeout(done,Number(params.get('applyDelay')||0)));
  const transport=(path,body,signal,method)=>attributeTransport(path+(path.includes('?')?'&':'?')+'delay='+Number(params.get('delay')||0),body,signal,method);
  const modal=createAdvancedMapSearchModal({transport,getApplied:()=>applied,getLayerIds:()=>null,getContext:()=>'',onApply:async request=>{await pause();if(params.has('failApply'))throw Error('確認用の反映エラー');applied=request;searches++;report()},analysis:{getSpecification:()=>colors,getColoring:()=>coloring,apply:async(s,c)=>{await pause();if(params.has('failApply'))throw Error('確認用の反映エラー');colors=s;coloring=c;applications++;report()}}});
  const open=document.createElement('button');open.textContent='詳しい検索と色分けを開く';open.onclick=()=>modal.open(open);document.querySelector('#app').append(open);modal.open(open);
} else if(view==='answer') {
  const action=location.origin+'/form-answers/map?applyDelay='+Number(params.get('applyDelay')||1000)+(params.has('failApply')?'&failApply=1':'');
  createApp({setup(){const open=ref(true);return()=>h(mobile?MobileAnswer:Answer,{isOpen:open.value,action,query:{mode:'latest',as_of:'2026-11-02T00:00:00Z',common_form_id:formId,conditions:[]},onClose:()=>open.value=false})}}).mount('#app');
} else if(view==='panels') {
  createApp({setup(){const before=ref(),after=ref();onMounted(async()=>{await nextTick();before.value.restoreDraft(specification,fields);after.value.restoreDraft(specification,fields)});
    const props={forms:[{id:formId,label:'設備点検'}],endpoint:'/form-answers/map-filter',query:{mode:'latest'},targets:['marker:one'],requiredForm:'',disabled:false,active:false};
    return()=>h('div',{id:'panels'},[h('section',{id:'before'},[h('h2','変更前の分析パネル'),h(mobile?BeforeMobile:Before,{...props,ref:before})]),h('section',{id:'after'},[h('h2','修正後の分析パネル'),h(mobile?Mobile:Pc,{...props,ref:after})])]);}}).mount('#app');
} else {
  createApp({setup(){const open=ref(true),restoring=ref(false);return()=>h(mobile?MobileList:List,{isOpen:open.value,restoring:restoring.value,endpoint:'/form-answers/map-presets',onClose:()=>open.value=false,onRestore:async()=>{restoring.value=true;await new Promise(done=>setTimeout(done,Number(params.get('delay')||1000)));document.querySelector('#output').textContent='下書きを呼び出しました（地図への適用なし）';restoring.value=false;}})}}).mount('#app');
}
</script></html>`;

const server = await createServer({
  root: frontend,
  configFile: false,
  define: {
    "import.meta.env.VITE_ASSET_PATH": JSON.stringify(
      `${moduleUrl(resolve(frontend, "../frontend-mobile/public"))}/`,
    ),
    "import.meta.env.VITE_IP_ADDRESS": JSON.stringify(""),
  },
  logLevel: "error",
  plugins: [
    {
      name: "fixture-api",
      load(id) {
        if (id === "\0fixture-api")
          return `const request=async(path,body,config={},method)=>({data:await fetch(path+(config.params?'?'+new URLSearchParams(config.params):''),{method:method||(body===undefined?'GET':'POST'),headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:config.signal}).then(r=>r.status===204?null:r.json())});export default {get:(p,c)=>request(p,undefined,c),post:request,delete:(p,c)=>request(p,undefined,c,'DELETE')};`;
      },
    },
    vue(),
    {
      name: "map-search-ui-fixture",
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          const url = new URL(req.url, "http://127.0.0.1");
          const json = (value) => {
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify(value));
          };
          if (url.pathname === "/scripts/mobile-map-analysis-preview.html") {
            const html = (
              await readFile(
                resolve(frontend, "scripts/mobile-map-analysis-preview.html.template"),
                "utf8",
              )
            )
              .replace(
                "__LEAFLET_CSS__",
                moduleUrl(
                  resolve(frontend, "../template-scripts/node_modules/leaflet/dist/leaflet.css"),
                ),
              )
              .replace(
                "__LEAFLET_JS__",
                moduleUrl(
                  resolve(
                    frontend,
                    "../template-scripts/node_modules/leaflet/dist/leaflet-src.esm.js",
                  ),
                ),
              )
              .replace(
                "__ANSWER_COLORING__",
                moduleUrl(resolve(frontend, "../template-scripts/src/map/answer-coloring.ts")),
              );
            res.setHeader("content-type", "text/html; charset=utf-8");
            res.end(await server.transformIndexHtml(req.url, html));
            return;
          }
          if (url.pathname === "/map-search-ui.html") {
            res.setHeader("content-type", "text/html; charset=utf-8");
            const html = url.searchParams.has("template")
              ? fixture.replace("<style>", '<link rel="stylesheet" href="/github.css"><style>')
              : fixture;
            res.end(await server.transformIndexHtml(req.url, html));
            return;
          }
          // 登録地図の実コンポーネントに、確認用の地図から反映完了・失敗を返す。
          if (url.pathname === "/form-answers/map" && req.method === "POST") {
            let body = "";
            for await (const chunk of req) body += chunk;
            const data = new URLSearchParams(body);
            const requestId = data.get("request_id"),
              origin = data.get("parent_origin");
            const query = JSON.parse(data.get("query"));
            const delay = Math.min(
              10000,
              Math.max(0, Number(url.searchParams.get("applyDelay") || 0)),
            );
            res.setHeader("content-type", "text/html; charset=utf-8");
            res.end(`<!doctype html><html lang="ja"><meta charset="utf-8"><style>body{font:18px sans-serif;background:#e5edf0;padding:24px}</style><h2>確認用地図</h2><p id="state">対象1件</p><script>
              const requestId=${JSON.stringify(requestId)},origin=${JSON.stringify(origin)};
              const send=data=>parent.postMessage({requestId,...data},origin);
              addEventListener('message',e=>{if(e.source!==parent||e.origin!==origin||e.data.requestId!==requestId)return;const data=e.data;if(data.type==='answer-map-filter')setTimeout(()=>{document.querySelector('#state').textContent='応答対象：'+data.targets.length+'件';send(${url.searchParams.has("failApply") ? "{type:'answer-map-filter-error',updateId:data.updateId,message:'確認用の反映エラー'}" : "{type:'answer-map-filter-applied',updateId:data.updateId,visible:data.targets.length,renderable:data.targets.length}"})},${delay})});
              send({type:'answer-map-ready',query:${JSON.stringify(query)},targets:['marker:one'],targetCount:1,answerCount:1,displayed:1,skipped:0});
            </script></html>`);
            return;
          }
          const delay = Math.min(10000, Math.max(0, Number(url.searchParams.get("delay") || 0)));
          if (delay && ["/common-forms", "/form-answers/map-filter"].includes(url.pathname))
            await new Promise((done) => setTimeout(done, delay));
          if (url.pathname === "/common-forms")
            return json([
              {
                id: formId,
                version: 1,
                form_title: "設備点検",
                form_schema: { fields: fields.map((f) => ({ ...f, type: f.field_type })) },
              },
            ]);
          if (url.pathname === "/form-answers/map-filter") {
            let body = "";
            for await (const chunk of req) body += chunk;
            const request = body ? JSON.parse(body) : {};
            const mobileScope = request.scope?.layer_ids?.includes("fixture-layer");
            const targets = mobileScope
              ? [
                  ["marker:one", 60],
                  ["shape:two", 30],
                ]
                  .filter(
                    ([key, age]) =>
                      (!request.targets || request.targets.includes(key)) &&
                      (request.conditions || []).every((c) =>
                        c.op === "gte"
                          ? age >= Number(c.value)
                          : c.op === "eq"
                            ? age === Number(c.value)
                            : true,
                      ),
                  )
                  .map(([key]) => key)
              : ["marker:one"];
            return json({
              forms: [{ id: formId, label: "設備点検" }],
              fields,
              forms_overflow: false,
              targets,
              target_count: targets.length,
              answer_count: targets.length,
              as_of: "2026-11-02T00:00:00Z",
            });
          }
          if (url.pathname === "/map-objects/search/attributes" && req.method === "POST") {
            let body = "";
            for await (const chunk of req) body += chunk;
            const request = JSON.parse(body);
            return json({
              common_form_id: request.common_form_id,
              definition_version: request.definition_version,
              as_of: "2026-11-05T00:00:00Z",
              marker_ids: ["one"],
              shape_ids: [],
              target_count: 1,
            });
          }
          if (url.pathname === "/form-answers/map-presets") {
            if (req.method === "GET")
              return json({ items: presets, total: presets.length, page: 1, page_size: 20 });
            let body = "";
            for await (const chunk of req) body += chunk;
            const draft = JSON.parse(body);
            const saved = preset(draft.kind, draft.name, draft.definition, "saved" + nextId++);
            presets.push(saved);
            return json(saved);
          }
          if (url.pathname.startsWith("/form-answers/map-presets/") && req.method === "DELETE") {
            const at = presets.findIndex((p) => p.id === url.pathname.split("/").pop());
            if (at >= 0) presets.splice(at, 1);
            res.statusCode = 204;
            return res.end();
          }
          next();
        });
      },
    },
  ],
  resolve: {
    dedupe: ["vue", "pinia"],
    alias: [
      {
        find: "@/axiosClient",
        replacement: "/@fixture-api",
        customResolver() {
          return "\0fixture-api";
        },
      },
      {
        find: "@",
        replacement: resolve(frontend, "src").replaceAll("\\", "/"),
        async customResolver(source, importer, options) {
          if (importer?.replaceAll("\\", "/").includes("/frontend-mobile/"))
            source = source.replace("/frontend/src/", "/frontend-mobile/src/");
          return this.resolve(source, importer, { ...options, skipSelf: true });
        },
      },
    ],
  },
  server: { host: "127.0.0.1", port: 5179, strictPort: true, fs: { allow: [root] } },
});
await server.listen();
console.log("UI fixture: http://127.0.0.1:5179/map-search-ui.html");
