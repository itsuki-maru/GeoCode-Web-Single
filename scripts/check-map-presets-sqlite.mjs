// 実際の Vue コンポーネントと、認証付きの SQLite HTTP API を使う。フロントエンドのソースは読み取り専用とする。
// 最初に実行: cargo test --test map_presets_browser -- --ignored --nocapture
// 続けて実行: node scripts/check-map-presets-sqlite.mjs --playwright-path=/path/to/playwright/index.mjs
import assert from "node:assert/strict";
import { readFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const at = arg.indexOf("=");
    return [arg.slice(2, at), arg.slice(at + 1)];
  }),
);
const root = fileURLToPath(new URL("../", import.meta.url));
const frontend = resolve(root, "src_frontend/frontend");
const moduleUrl = (path) =>
  pathToFileURL(resolve(frontend, "node_modules", path)).href;
const { createServer } = await import(moduleUrl("vite/dist/node/index.js"));
const { default: vue } = await import(
  moduleUrl("@vitejs/plugin-vue/dist/index.js")
);
const { chromium } = await import(
  args["playwright-path"]
    ? pathToFileURL(resolve(args["playwright-path"])).href
    : "playwright"
);
const manifest = JSON.parse(
  await readFile(resolve(root, "target/preset-browser-ready.json"), "utf8"),
);
const output = resolve(root, "target/preset-browser-check");
await mkdir(output, { recursive: true });
const fsUrl = (path) => `/@fs/${path.replaceAll("\\", "/")}`;
const mobileModule = fsUrl(
  resolve(
    root,
    "src_frontend/frontend-mobile/src/components/map-object/AnswerMapModal.vue",
  ),
);
const fixture = `<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="app"></div>
<script type="module">
import {createApp,ref,h} from 'vue'; import {createPinia} from 'pinia';
import Pc from '/src/components/map-object/AnswerMapModal.vue'; import Mobile from '${mobileModule}';
import '${fsUrl(resolve(root, "src_frontend/template-scripts/src/map/print/pdf-export.ts"))}';
const mobile=new URLSearchParams(location.search).has('mobile'),open=ref(true);
window.mapUpdates=[];window.addEventListener('message',e=>{if(e.data?.type==='answer-map-filter-applied')window.mapUpdates.push(e.data)});
createApp({setup:()=>()=>h(mobile?Mobile:Pc,{isOpen:open.value,
query:{mode:'latest',common_form_id:${JSON.stringify(manifest.form_id)},conditions:[]},
action:location.origin+'/form-answers/map',class:mobile?'answer-map-mobile-layout':undefined,
printEnabled:!mobile,onClose:()=>open.value=false})}).use(createPinia()).mount('#app');
</script></html>`;
const server = await createServer({
  root: frontend,
  configFile: false,
  logLevel: "error",
  define: { "import.meta.env.VITE_IP_ADDRESS": JSON.stringify("") },
  optimizeDeps: {
    entries: [
      resolve(frontend, "src/components/map-object/AnswerMapModal.vue"),
      resolve(root, "src_frontend/frontend-mobile/src/components/map-object/AnswerMapModal.vue"),
      resolve(root, "src_frontend/template-scripts/src/map/print/pdf-export.ts"),
    ],
  },
  resolve: {
    dedupe: ["vue", "pinia"],
    alias: [
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
  plugins: [
    vue(),
    {
      name: "sqlite-preset-browser",
      configureServer(vite) {
        vite.middlewares.use(async (req, res, next) => {
          if (req.url.startsWith("/sqlite-presets-check.html")) {
            res.setHeader("content-type", "text/html; charset=utf-8");
            res.end(await vite.transformIndexHtml(req.url, fixture));
            return;
          }
          if (req.url === "/sqlite-check-tile.svg") {
            res.setHeader("content-type", "image/svg+xml");
            res.end(
              '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><path fill="#e5edf0" d="M0 0h256v256H0z"/></svg>',
            );
            return;
          }
          const entries = {
            "/assets/template-form-answer-map.js": "form-answer-map.ts",
            "/assets/template-form-answer-map-print.js":
              "form-answer-map-print.ts",
          };
          if (entries[req.url]) {
            res.writeHead(302, {
              Location: fsUrl(
                resolve(
                  root,
                  "src_frontend/template-scripts/src/entries",
                  entries[req.url],
                ),
              ),
            });
            res.end();
            return;
          }
          next();
        });
      },
    },
  ],
  server: {
    host: "127.0.0.1",
    port: 0,
    fs: { allow: [resolve(root, "src_frontend")] },
    proxy: Object.fromEntries(
      ["/form-answers", "/account", "/assets", "/static"].map((path) => [
        path,
        { target: manifest.origin, changeOrigin: false },
      ]),
    ),
  },
});
await server.listen();
const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
const browser = await chromium.launch({
  channel: args.browser || "chrome",
  headless: true,
});
const errors = [],
  reports = [];
const capture = async (page, name) => {
  await page.evaluate(async () => {
    await new Promise((done) =>
      requestAnimationFrame(() => requestAnimationFrame(done)),
    );
    await Promise.all(
      document.getAnimations().map((a) => a.finished.catch(() => {})),
    );
  });
  await page.screenshot({ path: resolve(output, name), fullPage: true });
};
try {
  for (const mobile of [false, true]) {
    const context = await browser.newContext({
      viewport: mobile
        ? { width: 390, height: 844 }
        : { width: 1440, height: 1000 },
    });
    await context.addCookies([
      { name: "access_token", value: manifest.owner_token, url: origin },
    ]);
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    const calls = { save: 0, delete: 0, map: 0 };
    page.on("request", (request) => {
      const path = new URL(request.url()).pathname;
      if (request.method() === "POST" && path === "/form-answers/map-presets")
        calls.save++;
      if (
        request.method() === "DELETE" &&
        path.startsWith("/form-answers/map-presets/")
      )
        calls.delete++;
      if (request.method() === "POST" && path === "/form-answers/map")
        calls.map++;
    });
    await page.goto(
      `${origin}/sqlite-presets-check.html${mobile ? "?mobile" : ""}`,
    );
    const filter = page.locator(".filter-panel"),
      color = page.locator(".color-panel");
    await filter
      .getByRole("combobox", { name: "共通フォーム", exact: true })
      .selectOption(manifest.form_id);
    await filter
      .getByRole("button", { name: "条件を追加", exact: true })
      .click();
    const number = filter.getByRole("textbox", {
      name: "条件の値",
      exact: true,
    });
    await number.fill("50.000000000000000001");
    await filter
      .getByRole("button", { name: "検索条件を保存", exact: true })
      .click();
    let top = page.locator(".base-modal-overlay:visible").last();
    await top
      .getByRole("textbox", { name: "条件名", exact: true })
      .fill("取消確認");
    await top.getByRole("button", { name: "閉じる", exact: true }).click();
    assert.equal(calls.save, 0);
    await filter
      .getByRole("button", { name: "検索条件を保存", exact: true })
      .click();
    top = page.locator(".base-modal-overlay:visible").last();
    await top
      .getByRole("textbox", { name: "条件名", exact: true })
      .fill("50年以上");
    await capture(page, mobile ? "mobile-save.png" : "pc-save.png");
    await top.getByRole("button", { name: "保存", exact: true }).click();
    await page.getByText("検索条件を保存しました。", { exact: true }).waitFor();
    await number.fill("99");
    await page
      .getByRole("button", { name: "保存した検索条件", exact: true })
      .click();
    top = page.locator(".base-modal-overlay:visible").last();
    await top
      .getByRole("row")
      .filter({
        has: page.getByRole("cell", { name: "50年以上", exact: true }),
      })
      .getByRole("button", { name: "呼び出し", exact: true })
      .click();
    await page.waitForFunction(
      () =>
        document.querySelector('input[aria-label="条件の値"]')?.value ===
        "50.000000000000000001",
    );
    assert.equal(await page.evaluate(() => window.mapUpdates.length), 0);
    await filter
      .getByRole("button", { name: "絞り込み実行", exact: true })
      .click();
    await page.waitForFunction(() => window.mapUpdates.length === 1);
    const map = page
      .frames()
      .find((frame) => new URL(frame.url()).pathname === "/form-answers/map");
    assert.ok(map, "SQLite API rendered the actual Leaflet map");
    const cluster = map.locator(".marker-cluster");
    await cluster.first().waitFor();
    const style = () =>
      cluster.first().evaluate((e) => ({
        className: e.className,
        color: getComputedStyle(e).backgroundColor,
        text: e.textContent,
      }));
    const beforeColor = await style();
    assert.equal(beforeColor.text, "9");
    await color.locator("summary").click();
    await color
      .getByRole("combobox", { name: "色分けの共通フォーム", exact: true })
      .selectOption(manifest.form_id);
    await color
      .getByRole("button", { name: "分類を追加", exact: true })
      .click();
    await color
      .getByRole("textbox", { name: "分類名", exact: true })
      .fill("耐用年数50年以上");
    await color
      .getByRole("textbox", { name: "色分けの条件値", exact: true })
      .fill("50");
    await color
      .getByRole("button", { name: "検索条件を保存", exact: true })
      .click();
    top = page.locator(".base-modal-overlay:visible").last();
    await top
      .getByRole("textbox", { name: "条件名", exact: true })
      .fill("点検の分類");
    await top.getByRole("button", { name: "保存", exact: true }).click();
    await page.waitForFunction(
      () => !document.querySelector(".content-fullscreen-map[inert]"),
    );
    await color
      .getByRole("textbox", { name: "分類名", exact: true })
      .fill("変更中");
    await number.fill("99");
    await page
      .getByRole("button", { name: "保存した検索条件", exact: true })
      .click();
    top = page.locator(".base-modal-overlay:visible").last();
    await top
      .getByRole("row")
      .filter({ hasText: "点検の分類" })
      .getByRole("button", { name: "呼び出し", exact: true })
      .click();
    await page.waitForFunction(
      () =>
        document.querySelector('input[aria-label="分類名"]')?.value ===
        "耐用年数50年以上",
    );
    assert.equal(await number.inputValue(), "99");
    assert.equal(await page.evaluate(() => window.mapUpdates.length), 1);
    await color
      .getByRole("button", { name: "色分け実行", exact: true })
      .click();
    await page.waitForFunction(() => window.mapUpdates.length === 2);
    assert.deepEqual(
      await style(),
      beforeColor,
      "coloring preserves standard cluster style and count",
    );
    const listed = await (
      await context.request.get(`${origin}/form-answers/map-presets`)
    ).json();
    assert.equal(listed.total, 2);
    assert.equal(
      listed.items.find((p) => p.kind === "filter").definition.conditions[0]
        .value,
      "50.000000000000000001",
    );
    const other = await browser.newContext();
    await other.addCookies([
      { name: "access_token", value: manifest.other_token, url: origin },
    ]);
    const hidden = await (
      await other.request.get(`${origin}/form-answers/map-presets`)
    ).json();
    assert.equal(hidden.total, 0);
    assert.deepEqual(hidden.items, []);
    for (const preset of listed.items)
      assert.equal(
        (
          await other.request.delete(
            `${origin}/form-answers/map-presets/${preset.id}`,
          )
        ).status(),
        404,
      );
    await other.close();
    if (!mobile) {
      const printing = page.waitForEvent("framenavigated", {
        predicate: (frame) =>
          new URL(frame.url()).pathname === "/form-answers/map-print",
      });
      await page
        .getByRole("button", { name: "地図を印刷", exact: true })
        .click();
      await page.locator("dialog[open]").waitFor();
      const print = await printing;
      await print.locator(".answer-print-legend").waitFor();
      await print
        .getByRole("combobox", { name: "凡例の文字サイズ", exact: true })
        .selectOption("20");
      assert.deepEqual(
        await print
          .locator(".answer-print-legend strong,.answer-print-legend li")
          .evaluateAll((entries) =>
            entries.map((e) => getComputedStyle(e).fontSize),
          ),
        ["20px", "20px"],
      );
      await print.waitForFunction(
        () => !document.querySelector("#print-submit").disabled,
      );
      assert.equal(
        await print.locator("#print-status").innerText(),
        "印刷準備完了",
      );
      await capture(page, "pc-print.png");
      await print.locator("#pdf-export").click();
      await print
        .locator(".pdf-output [data-save]")
        .waitFor({ state: "visible", timeout: 30000 });
      const downloaded = page.waitForEvent("download");
      await print.locator(".pdf-output [data-save]").click();
      const pdf = await downloaded;
      const pdfPath = resolve(output, "sqlite-colored-map.pdf");
      await pdf.saveAs(pdfPath);
      assert.equal(
        (await readFile(pdfPath)).subarray(0, 5).toString(),
        "%PDF-",
      );
      await page
        .locator("dialog[open]")
        .getByRole("button", { name: "閉じる", exact: true })
        .click();
    }
    await page
      .getByRole("button", { name: "保存した検索条件", exact: true })
      .click();
    top = page.locator(".base-modal-overlay:visible").last();
    const row = () =>
      top.getByRole("row").filter({
        has: page.getByRole("cell", { name: "50年以上", exact: true }),
      });
    await row().getByRole("button", { name: "削除", exact: true }).click();
    await page
      .locator(".base-modal-overlay:visible")
      .last()
      .getByRole("button", { name: "閉じる", exact: true })
      .click();
    assert.equal(calls.delete, 0);
    top = page.locator(".base-modal-overlay:visible").last();
    await row().getByRole("button", { name: "削除", exact: true }).click();
    await page
      .locator(".base-modal-overlay:visible")
      .last()
      .getByRole("button", { name: "削除", exact: true })
      .click();
    await page.waitForFunction(
      () => document.querySelectorAll("table tbody tr").length === 1,
    );
    await capture(page, mobile ? "mobile-list.png" : "pc-list.png");
    await page.keyboard.press("Escape");
    assert.equal(calls.map, 1, "save/restore/delete do not reload the map");
    assert.equal(
      await page.evaluate(() => window.mapUpdates.length),
      2,
      "deletion keeps applied map state",
    );
    assert.equal(await number.inputValue(), "99");
    const remaining = await (
      await context.request.get(`${origin}/form-answers/map-presets`)
    ).json();
    assert.equal(remaining.total, 1);
    assert.equal(
      (
        await context.request.delete(
          `${origin}/form-answers/map-presets/${remaining.items[0].id}`,
        )
      ).status(),
      204,
    );
    reports.push({
      device: mobile ? "mobile" : "PC",
      ...calls,
      applied: 2,
      ownerIsolation: true,
    });
    await context.close();
  }
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({ passed: reports, screenshots: output }, null, 2),
  );
} finally {
  await browser.close();
  await server.close();
  await fetch(`${manifest.origin}/__browser_check_shutdown`).catch(() => {});
}
