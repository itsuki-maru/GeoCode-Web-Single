// 実際のVueコンポーネントとブラウザで操作を確認する。APIはこの画面確認用のfixture。
// 所有者制御・永続化は tests/answer_map_presets.rs の独立したPostgreSQL DBで検証する。
// node scripts/check-map-presets.mjs --playwright-path=/path/to/playwright/index.mjs
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createServer } from "vite";
import vue from "@vitejs/plugin-vue";

const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const at = arg.indexOf("=");
    return [arg.slice(2, at), arg.slice(at + 1)];
  }),
);
const { chromium } = await import(
  args["playwright-path"] ? pathToFileURL(resolve(args["playwright-path"])).href : "playwright"
);
const frontend = fileURLToPath(new URL("../", import.meta.url));
const mobileModule = `/@fs/${resolve(frontend, "../frontend-mobile/src/components/map-object/AnswerMapModal.vue").replaceAll("\\", "/")}`;
const output = resolve(frontend, "../../dist/preset-check");
await mkdir(output, { recursive: true });
const fixture = `<!doctype html><html lang="ja"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><div id="app"></div>
<script type="module">
import {createApp,ref,h} from 'vue';
import {createPinia} from 'pinia';
import Pc from '/src/components/map-object/AnswerMapModal.vue';
import Mobile from '${mobileModule}';
const open=ref(true); window.mapMessages=[];
window.addEventListener('message', e=>{if(e.data?.type==='fixture-applied')window.mapMessages.push(e.data)});
createApp({setup:()=>()=>h(new URLSearchParams(location.search).has('mobile')?Mobile:Pc,
{isOpen:open.value,query:{mode:'latest',conditions:[]},action:location.origin+'/form-answers/map',
class:new URLSearchParams(location.search).has('mobile')?'answer-map-mobile-layout':undefined,
printEnabled:!new URLSearchParams(location.search).has('mobile'),onClose:()=>open.value=false})})
.use(createPinia()).mount('#app');
</script></html>`;
const server = await createServer({
  root: frontend,
  configFile: false,
  logLevel: "error",
  plugins: [
    vue(),
    {
      name: "map-preset-check",
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          if (!req.url.startsWith("/presets-check.html")) return next();
          res.setHeader("content-type", "text/html; charset=utf-8");
          res.end(await server.transformIndexHtml(req.url, fixture));
        });
      },
    },
  ],
  define: { "import.meta.env.VITE_IP_ADDRESS": JSON.stringify("") },
  resolve: {
    dedupe: ["vue", "pinia"],
    alias: [
      {
        find: "@",
        replacement: resolve(frontend, "src").replaceAll("\\", "/"),
        async customResolver(source, importer, options) {
          // モバイル版では、本番と同じ専用の BaseModal/MessageModal とユーティリティーを使う。
          if (importer?.replaceAll("\\", "/").includes("/frontend-mobile/"))
            source = source.replace("/frontend/src/", "/frontend-mobile/src/");
          return this.resolve(source, importer, { ...options, skipSelf: true });
        },
      },
    ],
  },
  server: { host: "127.0.0.1", port: 0, fs: { allow: [resolve(frontend, "..")] } },
});
await server.listen();
const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
const browser = await chromium.launch({ channel: args.browser || "chrome", headless: true });
const formId = "00000000-0000-0000-0000-000000000001";
const fieldId = "life_years";
const target = "marker:00000000-0000-0000-0000-000000000003";
const forms = [{ id: formId, label: "設備点検" }];
const fields = [{ id: fieldId, label: "耐用年数", field_type: "number", choices: [] }];
const result = {
  forms,
  fields,
  forms_overflow: false,
  targets: [target],
  target_count: 1,
  answer_count: 1,
};
const errors = [];
const reports = [];
const capture = async (page, name) => {
  await page.evaluate(async () => {
    await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
    await Promise.all(
      document.getAnimations().map((animation) => animation.finished.catch(() => {})),
    );
  });
  await page.screenshot({ path: resolve(output, name), fullPage: true });
};
try {
  for (const mobile of [false, true]) {
    const context = await browser.newContext({
      viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
    });
    const page = await context.newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    const presets = [];
    let missingField = false;
    const calls = { save: 0, delete: 0, map: 0, filter: 0 };
    await page.route("**/form-answers/**", async (route) => {
      const request = route.request(),
        url = new URL(request.url());
      const json = (value, status = 200) =>
        route.fulfill({ status, contentType: "application/json", body: JSON.stringify(value) });
      if (url.pathname === "/form-answers/map") {
        calls.map++;
        const params = new URLSearchParams(request.postData());
        const requestId = params.get("request_id");
        return route.fulfill({
          contentType: "text/html",
          body: `<html lang="ja"><body style="background:#e5edf0;font-family:sans-serif">回答地図の通信fixture<script>
          const requestId=${JSON.stringify(requestId)};
          window.addEventListener('message', e=>{const d=e.data;if(d?.type==='answer-map-filter'){
            parent.postMessage({type:'fixture-applied',updateId:d.updateId,coloring:d.coloring},location.origin);
            parent.postMessage({type:'answer-map-filter-applied',requestId,updateId:d.updateId,visible:d.targets.length,renderable:d.targets.length},location.origin);
          }});
          parent.postMessage({type:'answer-map-ready',requestId,answerCount:1,targetCount:1,displayed:1,skipped:0,
          query:{mode:'latest',conditions:[],as_of:'2026-10-25T00:00:00Z'},targets:[${JSON.stringify(target)}]},location.origin);
          </script></body></html>`,
        });
      }
      if (url.pathname === "/form-answers/map-filter") {
        calls.filter++;
        return json({ ...result, fields: missingField ? [] : fields });
      }
      if (url.pathname === "/form-answers/map-presets") {
        if (request.method() === "GET")
          return json({ items: presets, total: presets.length, page: 1, page_size: 20 });
        calls.save++;
        const body = request.postDataJSON();
        const preset = {
          ...body,
          id: `00000000-0000-0000-0001-${String(calls.save).padStart(12, "0")}`,
          create_at: "2026-10-25T00:00:00Z",
          display: {
            form_label: "設備点検",
            fields: [{ id: fieldId, field_type: "number", label: "耐用年数" }],
          },
        };
        presets.push(preset);
        return json(preset, 201);
      }
      if (url.pathname.startsWith("/form-answers/map-presets/")) {
        calls.delete++;
        const at = presets.findIndex((p) => p.id === url.pathname.split("/").pop());
        if (at === -1) return json({}, 404);
        presets.splice(at, 1);
        return route.fulfill({ status: 204 });
      }
      return json({ error: "Unexpected fixture request" }, 500);
    });
    await page.goto(`${origin}/presets-check.html${mobile ? "?mobile" : ""}`);
    const filter = page.locator(".filter-panel");
    const color = page.locator(".color-panel");
    await filter.getByRole("combobox", { name: "共通フォーム", exact: true }).selectOption(formId);
    await filter.getByRole("button", { name: "条件を追加", exact: true }).click();
    const number = filter.getByRole("textbox", { name: "条件の値", exact: true });
    await number.fill("50.000000000000000001");
    const saveButton = filter.getByRole("button", { name: "検索条件を保存", exact: true });
    await saveButton.click();
    let top = page.locator(".base-modal-overlay:visible").last();
    await top.getByRole("textbox").fill("閉じるテスト");
    await capture(page, mobile ? "mobile-save.png" : "pc-save.png");
    await top.getByRole("button", { name: "閉じる", exact: true }).click();
    assert.equal(calls.save, 0, "保存名モーダルを閉じても保存しない");
    await saveButton.click();
    top = page.locator(".base-modal-overlay:visible").last();
    await top.getByRole("textbox").fill("50年以上");
    await top.getByRole("button", { name: "保存", exact: true }).click();
    await page.waitForFunction(
      () =>
        !document.querySelector('.base-modal-overlay[style*="110"]') ||
        [...document.querySelectorAll('.base-modal-overlay[style*="110"]')].every(
          (e) => getComputedStyle(e).display === "none",
        ),
    );
    assert.equal(calls.save, 1);
    assert.equal(presets[0].definition.conditions[0].value, "50.000000000000000001");
    await number.fill("99");
    const initialMapLoads = calls.map;
    missingField = true;
    await page.getByRole("button", { name: "保存した検索条件", exact: true }).click();
    top = page.locator(".base-modal-overlay:visible").last();
    await top
      .getByRole("row")
      .filter({ hasText: "50年以上" })
      .getByRole("button", { name: "呼び出し", exact: true })
      .click();
    await top.getByRole("alert").waitFor();
    assert.equal(await number.inputValue(), "99", "項目が利用できない場合は元の入力を保持する");
    assert.equal(await page.evaluate(() => window.mapMessages.length), 0);
    missingField = false;
    await top
      .getByRole("row")
      .filter({ hasText: "50年以上" })
      .getByRole("button", { name: "呼び出し", exact: true })
      .click();
    await number.waitFor();
    await page.waitForFunction(
      () =>
        document.querySelector('input[aria-label="条件の値"]')?.value === "50.000000000000000001",
    );
    assert.equal(calls.map, initialMapLoads, "呼び出しでiframeを再読込しない");
    assert.equal(
      await page.evaluate(() => window.mapMessages.length),
      0,
      "呼び出しだけで地図へ反映しない",
    );
    await filter.getByRole("button", { name: "絞り込み実行", exact: true }).click();
    await page.waitForFunction(() => window.mapMessages.length === 1);
    await color.locator("summary").click();
    await color
      .getByRole("combobox", { name: "色分けの共通フォーム", exact: true })
      .selectOption(formId);
    await color.getByRole("button", { name: "分類を追加", exact: true }).click();
    await color.getByRole("textbox", { name: "分類名", exact: true }).fill("耐用年数50年以上");
    await color.getByRole("textbox", { name: "色分けの条件値", exact: true }).fill("50");
    await color.getByRole("button", { name: "検索条件を保存", exact: true }).click();
    top = page.locator(".base-modal-overlay:visible").last();
    await top.getByRole("textbox").fill("点検の分類");
    await top.getByRole("button", { name: "保存", exact: true }).click();
    await page.waitForFunction(() =>
      [...document.querySelectorAll(".base-modal-overlay")].every(
        (e) => getComputedStyle(e).display === "none",
      ),
    );
    assert.equal(calls.save, 2);
    await color.getByRole("textbox", { name: "分類名", exact: true }).fill("変更中");
    await page.getByRole("button", { name: "保存した検索条件", exact: true }).click();
    top = page.locator(".base-modal-overlay:visible").last();
    await top
      .getByRole("row")
      .filter({ hasText: "点検の分類" })
      .getByRole("button", { name: "呼び出し", exact: true })
      .click();
    await page.waitForFunction(
      () => document.querySelector('input[aria-label="分類名"]')?.value === "耐用年数50年以上",
    );
    assert.equal(
      await number.inputValue(),
      "50.000000000000000001",
      "色分け呼び出しで絞り込み入力を変更しない",
    );
    assert.equal(await page.evaluate(() => window.mapMessages.length), 1);
    await color.getByRole("button", { name: "色分け実行", exact: true }).click();
    await page.waitForFunction(() => window.mapMessages.length === 2);
    await page.getByRole("button", { name: "保存した検索条件", exact: true }).click();
    top = page.locator(".base-modal-overlay:visible").last();
    await top
      .getByRole("row")
      .filter({ has: page.getByRole("cell", { name: "50年以上", exact: true }) })
      .getByRole("button", { name: "削除", exact: true })
      .click();
    top = page.locator(".base-modal-overlay:visible").last();
    await top.getByText("削除しますか？", { exact: true }).waitFor();
    await capture(page, mobile ? "mobile-delete.png" : "pc-delete.png");
    await top.getByRole("button", { name: "閉じる", exact: true }).click();
    assert.equal(calls.delete, 0, "削除確認の閉じるで削除しない");
    top = page.locator(".base-modal-overlay:visible").last();
    await top
      .getByRole("row")
      .filter({ has: page.getByRole("cell", { name: "50年以上", exact: true }) })
      .getByRole("button", { name: "削除", exact: true })
      .click();
    await page.keyboard.press("Escape");
    assert.equal(calls.delete, 0, "削除確認のEscで削除しない");
    assert.ok(await page.locator(".answer-map-overlay").isVisible(), "Escで親地図を閉じない");
    top = page.locator(".base-modal-overlay:visible").last();
    await top
      .getByRole("row")
      .filter({ has: page.getByRole("cell", { name: "50年以上", exact: true }) })
      .getByRole("button", { name: "削除", exact: true })
      .click();
    top = page.locator(".base-modal-overlay:visible").last();
    await top.getByRole("button", { name: "削除", exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll("table tbody tr").length === 1);
    assert.equal(calls.delete, 1);
    assert.equal(presets.length, 1);
    await capture(page, mobile ? "mobile-list.png" : "pc-list.png");
    await page.keyboard.press("Escape");
    assert.ok(await page.locator(".answer-map-overlay").isVisible());
    assert.equal(await number.inputValue(), "50.000000000000000001");
    assert.equal(calls.map, initialMapLoads, "保存・復元・削除の操作で地図を再読込しない");
    assert.equal(
      await page.evaluate(() => window.mapMessages.length),
      2,
      "削除で適用済みの地図を変更しない",
    );
    await capture(page, mobile ? "mobile-map.png" : "pc-map.png");
    reports.push({ device: mobile ? "mobile" : "PC", ...calls, applied: 2 });
    await context.close();
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: reports, screenshots: output }, null, 2));
} finally {
  await browser.close();
  await server.close();
}
