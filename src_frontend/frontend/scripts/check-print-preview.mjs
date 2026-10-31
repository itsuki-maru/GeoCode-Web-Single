// 共通 CSS を含む実際の地図テンプレートを、ローカルのテスト用タイルで描画する。
// 事前に frontend で npm run build を実行する。Playwright は品質確認用の任意の依存パッケージ。
// 実行例: node scripts/check-print-preview.mjs --browser=chrome --playwright-path=/path/to/playwright/index.mjs
// ポップアップの内容は --popup=marker または --popup=shape、PDF 出力は --pdf=client を付けて確認する。
// 回答地図の色分け・凡例は --coloring=true を付けて確認する。
// クラスタ表示の維持と印刷への引き継ぎは --clusters=true を付けて確認する。
// ページ数と内容の確認: python scripts/check-print-preview-pdfs.py ../../dist/print-check/chrome
import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createServer } from "vite";

const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const index = arg.indexOf("=");
    return [arg.slice(2, index), arg.slice(index + 1)];
  }),
);
if (args.clusters === "true") {
  const { checkAnswerClusters } = await import("./check-answer-clusters.mjs");
  await checkAnswerClusters(args);
  process.exit(0);
}
const { chromium } = await import(
  args["playwright-path"] ? pathToFileURL(resolve(args["playwright-path"])).href : "playwright"
);
const root = fileURLToPath(new URL("../../../", import.meta.url));
const channel = args.browser || "chrome";
const output = resolve(root, args.output || `dist/print-check/${channel}`);
await mkdir(output, { recursive: true });
const baselineCss = args["baseline-css"]
  ? await readFile(resolve(args["baseline-css"]), "utf8")
  : null;
const state = {
  view: { latitude: 35.68, longitude: 139.76, zoom: 13 },
  tileServerId: "1",
  overlays: {},
  markersVisible: true,
  shapesVisible: true,
  shapeNamesVisible: true,
  layerIds: null,
};
const bootstrap = {
  page: "map-anather",
  isCluster: false,
  initialView: state.view,
  tileServers: {
    1: {
      url: "/print-test-tile.svg",
      attribution: "PRINT TEST SOURCE",
      label: "標準地図",
      layer_name: "標準地図",
      include_foreign_tiles: true,
      min_zoom: 0,
      max_zoom: 18,
    },
  },
  tileOverlays: [],
  layers: { a: { id: "a", layer_name: "避難所" } },
  markers: {
    a: {
      id: "a",
      layer_id: "a",
      marker_name: "避難所A",
      detail: "MARKER POPUP CONTENT\n\n![確認画像](/print-test-tile.svg)",
      latitude: 35.68,
      longitude: 139.76,
    },
  },
  shapes: [
    {
      id: "area",
      layer_id: "a",
      name: "避難対象区域",
      shape_type: "polygon",
      geojson: {
        type: "Feature",
        properties: { memo: "SHAPE POPUP CONTENT\n\n![確認画像](/print-test-tile.svg)" },
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [139.75, 35.67],
              [139.77, 35.67],
              [139.76, 35.69],
              [139.75, 35.67],
            ],
          ],
        },
      },
    },
  ],
};
const coloring =
  args.coloring === "true"
    ? {
        version: 1,
        rules: [
          { id: "red", label: "要確認", color: "#d73027" },
          { id: "blue", label: "対応済み", color: "#2166ac" },
        ],
        targets: { "marker:a": "red", "shape:area": "blue" },
      }
    : undefined;
if (coloring) {
  bootstrap.markers.b = {
    ...bootstrap.markers.a,
    id: "b",
    marker_name: "避難所B",
    longitude: 139.762,
  };
  coloring.targets["marker:b"] = "red";
  bootstrap.page = "form-answer-map";
  bootstrap.answerPreview = {
    answerCount: 3,
    targetCount: 3,
    parentOrigin: "http://localhost",
    requestId: "print-coloring-check",
    query: {},
    targets: Object.keys(coloring.targets),
  };
}
let template = await readFile(resolve(root, "src/templates/map-anather.html"), "utf8");
template = template.replace(
  /window\.__GEOCODE_MAP_BOOTSTRAP__ = \{[\s\S]*?\n        \};/,
  `window.__GEOCODE_MAP_BOOTSTRAP__ = ${JSON.stringify(bootstrap)};`,
);
template = template.replace(
  '<script type="module" src="/assets/template-map-anather.js"></script>',
  `<script type="module">
  import { createPrintPreview } from "/src/map/print/print-preview.ts";
  window.printTestMap = createPrintPreview(${JSON.stringify(state)}, () => {}, ${JSON.stringify(bootstrap.page)}, undefined, ${JSON.stringify(coloring)}).map;
  if (new URLSearchParams(location.search).has("baseline")) {
    [...document.head.querySelectorAll("style")].find(style => style.textContent.includes("#print-layout")).textContent = ${JSON.stringify(baselineCss)};
  }
  document.documentElement.dataset.printFixtureReady = "true";
</script>`,
);
const server = await createServer({
  root: resolve(root, "src_frontend/template-scripts"),
  configFile: false,
  publicDir: false,
  logLevel: "error",
  server: { host: "127.0.0.1", port: 0 },
  plugins: [
    {
      name: "print-fixture",
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          const path = new URL(req.url, "http://localhost").pathname;
          if (path === "/print-check.html") {
            res.setHeader("Content-Type", "text/html; charset=utf-8");
            res.end(template);
            return;
          }
          if (path === "/print-test-tile.svg") {
            res.setHeader("Content-Type", "image/svg+xml");
            res.end(
              '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#e8eedf"/><path d="M0 70H256M80 0V256M0 200H256M210 0V256" stroke="white" stroke-width="10"/><rect x="100" y="95" width="70" height="65" rx="8" fill="#bcd6ae"/></svg>',
            );
            return;
          }
          // 通常の印刷は選択された各レイヤを遅延読み込みする。回答印刷のスナップショットと同様に、
          // データベースを使わず、同じテスト用オブジェクトを返す。
          if (path === "/marker/read/all" || path === "/shapes") {
            const query = new URL(req.url, "http://localhost").searchParams;
            const layer = query.get("layer") ?? query.get("layer_id");
            res.setHeader("Content-Type", "application/json");
            res.end(
              JSON.stringify(
                path === "/shapes"
                  ? bootstrap.shapes.filter((shape) => shape.layer_id === layer)
                  : Object.fromEntries(
                      Object.entries(bootstrap.markers).filter(
                        ([, marker]) => marker.layer_id === layer,
                      ),
                    ),
              ),
            );
            return;
          }
          if (path.startsWith("/assets/")) {
            const name = basename(path);
            try {
              const body = await readFile(resolve(root, "src_frontend/frontend/dist", name));
              res.setHeader(
                "Content-Type",
                { ".js": "text/javascript", ".css": "text/css", ".png": "image/png" }[
                  extname(name)
                ] || "application/octet-stream",
              );
              res.end(body);
            } catch {
              res.statusCode = 404;
              res.end();
            }
            return;
          }
          next();
        });
      },
    },
  ],
});
await server.listen();
const corsServer = createHttpServer((_req, res) => {
  res.setHeader("Content-Type", "image/svg+xml");
  res.end(
    '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="blue"/></svg>',
  );
});
await new Promise((resolve) => corsServer.listen(0, "127.0.0.1", resolve));
let browser;
try {
  browser = await chromium.launch({ channel, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const url = `http://127.0.0.1:${server.httpServer.address().port}/print-check.html`;
  if (baselineCss) {
    await page.goto(`${url}?baseline=1`);
    await page.waitForSelector('[data-print-fixture-ready="true"]');
    await page.waitForFunction(() => !document.querySelector("#print-submit").disabled);
    await page.pdf({
      path: resolve(output, "baseline-a4-landscape.pdf"),
      preferCSSPageSize: true,
      printBackground: true,
    });
  }
  await page.goto(url);
  await page.waitForSelector('[data-print-fixture-ready="true"]');
  const resizeLegend = async (dx = 90, dy = 50) => {
    const legend = page.locator(".answer-print-legend");
    const before = await legend.evaluate((node) => ({
      width: node.offsetWidth,
      height: node.offsetHeight,
    }));
    const bounds = await legend.boundingBox();
    await page.mouse.move(bounds.x + bounds.width - 3, bounds.y + bounds.height - 3);
    await page.mouse.down();
    await page.mouse.move(bounds.x + bounds.width + dx, bounds.y + bounds.height + dy, {
      steps: 5,
    });
    await page.mouse.up();
    await page.waitForFunction(
      ({ width, height }) => {
        const legend = document.querySelector(".answer-print-legend");
        return legend.offsetWidth > width + 10 && legend.offsetHeight > height + 10;
      },
      before,
      { timeout: 5000 },
    );
  };
  if (coloring) {
    const legend = page.locator(".answer-print-legend");
    const markerChoice = page.getByRole("checkbox", { name: "要確認", exact: true });
    const show = page.getByRole("checkbox", { name: "凡例を表示", exact: true });
    const link = page.getByRole("checkbox", { name: "地図と連動", exact: true });
    assert.equal(await legend.isVisible(), true);
    assert.equal(await legend.locator("li:visible").count(), 2);
    assert.equal(await page.locator(".answer-value-marker").count(), 2);
    assert.deepEqual(await legend.locator("li").allTextContents(), ["要確認", "対応済み"]);
    const view = await page.evaluate(() => ({
      center: window.printTestMap.getCenter(),
      zoom: window.printTestMap.getZoom(),
    }));
    await markerChoice.uncheck();
    assert.equal(await legend.locator("li:visible").count(), 1);
    assert.equal(
      await page.locator(".answer-value-marker").count(),
      2,
      "Legend-only toggles preserve the map",
    );
    await link.check();
    assert.equal(await page.locator(".answer-value-marker").count(), 0);
    await show.uncheck();
    assert.equal(await legend.isVisible(), false);
    assert.equal(await page.locator(".answer-value-marker").count(), 0);
    await link.uncheck();
    assert.equal(await page.locator(".answer-value-marker").count(), 2);
    await markerChoice.check();
    await show.check();
    for (const size of [8, 12, 18, 32]) {
      await page.getByLabel("凡例の文字サイズ", { exact: true }).selectOption(String(size));
      const fonts = await legend.evaluate((node) => ({
        panel: getComputedStyle(node).fontSize,
        heading: getComputedStyle(node.querySelector("strong")).fontSize,
        labels: [...node.querySelectorAll("li")].map((label) => getComputedStyle(label).fontSize),
        swatches: [...node.querySelectorAll(".answer-print-legend-swatch")].map((swatch) => ({
          font: getComputedStyle(swatch).fontSize,
          width: getComputedStyle(swatch).width,
          height: getComputedStyle(swatch).height,
        })),
      }));
      assert.equal(fonts.panel, `${size}px`);
      assert.equal(fonts.heading, `${size}px`);
      assert.deepEqual(fonts.labels, [`${size}px`, `${size}px`]);
      assert.equal(
        await page
          .locator(".answer-print-legend-option")
          .first()
          .evaluate((node) => getComputedStyle(node).fontSize),
        "13px",
        "The legend font setting must not resize the sidebar controls",
      );
      for (const swatch of fonts.swatches) {
        assert.deepEqual(swatch, { font: `${size}px`, width: `${size}px`, height: `${size}px` });
      }
      await page.screenshot({ path: resolve(output, `font-${size}.png`), fullPage: true });
    }
    await page.getByLabel("凡例の文字サイズ", { exact: true }).selectOption("18");
    const before = await legend.boundingBox();
    const handle = await legend.locator("strong").boundingBox();
    await page.mouse.move(handle.x + 12, handle.y + 8);
    await page.mouse.down();
    await page.mouse.move(handle.x + 132, handle.y + 86, { steps: 5 });
    await page.mouse.up();
    const after = await legend.boundingBox();
    assert.ok(after.x > before.x + 50, "The floating legend must move");
    await resizeLegend();
    assert.deepEqual(
      await page.evaluate(() => ({
        center: window.printTestMap.getCenter(),
        zoom: window.printTestMap.getZoom(),
      })),
      view,
      "Legend changes must not pan or reload the map",
    );
    console.log(
      `${channel}: classification visibility, font size, scaled legend dragging and resizing verified`,
    );
  } else {
    assert.equal(
      await page.locator(".answer-print-legend-settings").count(),
      0,
      "Ordinary print has no coloring controls",
    );
  }
  for (const paper of [
    "a4-portrait",
    "a4-landscape",
    "a3-portrait",
    "a3-landscape",
    "b5-portrait",
    "b5-landscape",
  ]) {
    for (const titled of [false, true]) {
      await page.emulateMedia({ media: "screen" });
      await page.locator("#print-size").selectOption(paper);
      await page
        .locator("#print-title-input")
        .fill(
          titled
            ? "避難場所の案内図：タイトルの折り返しと印刷範囲を確認するためのサンプルです"
            : "",
        );
      if (args.popup) {
        await page.evaluate((kind) => {
          const map = window.printTestMap;
          map.closePopup();
          map.eachLayer((layer) => {
            if (kind === "marker" && layer instanceof L.Marker) layer.openPopup();
            if (kind === "shape" && layer.shapeMemo)
              layer.fire("click", { latlng: map.getCenter() });
          });
        }, args.popup);
        await page.locator(".leaflet-popup-content img").last().waitFor({ state: "visible" });
      }
      try {
        await page.waitForFunction(() => !document.querySelector("#print-submit").disabled);
      } catch (error) {
        console.error(await page.locator("#print-status").innerText());
        console.error(
          await page
            .locator("#map img")
            .evaluateAll((images) =>
              images.filter((img) => !img.complete || !img.naturalWidth).map((img) => img.src),
            ),
        );
        console.error(errors);
        await page.screenshot({ path: resolve(output, "readiness-error.png"), fullPage: true });
        throw error;
      }
      if (args.pdf === "client") {
        if (args.popup)
          assert.equal(await page.locator(".pdf-output [data-save]").isVisible(), false);
        await page.locator("#pdf-export").click();
        try {
          await page
            .locator(".pdf-output [data-save]")
            .waitFor({ state: "visible", timeout: 30000 });
        } catch (error) {
          console.error(await page.locator(".pdf-output").innerText());
          await page.screenshot({ path: resolve(output, "client-error.png"), fullPage: true });
          throw error;
        }
        const downloadEvent = page.waitForEvent("download");
        assert.equal(await page.locator("iframe.html2canvas-container").count(), 0);
        await page.locator(".pdf-output [data-save]").click();
        const download = await downloadEvent;
        await download.saveAs(resolve(output, `client-${paper}-${titled ? "title" : "blank"}.pdf`));
        if (args.popup)
          assert.equal(await page.locator(".leaflet-popup-content").isVisible(), true);
        await page.screenshot({
          path: resolve(output, `client-${paper}-${titled ? "title" : "blank"}-preview.png`),
          fullPage: true,
        });
        console.log(`${channel}: client PDF ${paper} ${titled}`);
        if (coloring) {
          const show = page.getByRole("checkbox", { name: "凡例を表示", exact: true });
          if (paper === "a4-portrait" && !titled) await resizeLegend(25, 25);
          else if (paper === "a4-portrait" && titled)
            await page.getByLabel("凡例の文字サイズ", { exact: true }).selectOption("19");
          else await show.uncheck();
          await page.waitForFunction(
            () => document.querySelector(".pdf-output [data-save]").hidden,
          );
          assert.equal(
            await page.locator(".pdf-output [data-save]").isVisible(),
            false,
            "Legend visibility, font and size changes invalidate the generated PDF",
          );
          await show.check();
        }
        continue;
      }
      const dimensions = () => {
        const map = document.querySelector("#map");
        return { width: map.clientWidth, height: map.clientHeight };
      };
      const previewSize = await page.evaluate(dimensions);
      await page.emulateMedia({ media: "print" });
      if (args.popup) {
        assert.equal(await page.locator(".leaflet-popup-content").isVisible(), true);
        assert.equal(await page.locator(".leaflet-popup-close-button").isVisible(), false);
      }
      assert.deepEqual(
        await page.evaluate(dimensions),
        previewSize,
        "Map dimensions must not change for print",
      );
      const name = `${paper}-${titled ? "title" : "blank"}`;
      await page.pdf({
        path: resolve(output, `${name}.pdf`),
        preferCSSPageSize: true,
        printBackground: true,
        displayHeaderFooter: false,
      });
      await page.screenshot({ path: resolve(output, `${name}.png`), fullPage: true });
      console.log(`${channel}: ${name} rendered`);
    }
  }
  if (args.pdf === "client") {
    // 表示できる外部オリジンの画像でも、CORS が許可されていない場合は明示的に失敗させ、
    // 地図の画像が欠けた PDF を、正常に出力できたように扱わない。
    await page.evaluate(async (src) => {
      const img = document.createElement("img");
      img.id = "cors-test-image";
      img.style.cssText = "position:absolute;left:100px;top:100px;width:32px;height:32px";
      img.src = src;
      document.querySelector("#print-paper").append(img);
      await img.decode();
    }, `http://127.0.0.1:${corsServer.address().port}/image.svg`);
    await page.locator("#pdf-export").click();
    await page.waitForFunction(() =>
      document
        .querySelector(".pdf-output [data-status]")
        .textContent.includes("PDFを作成できませんでした"),
    );
    assert.equal(await page.locator(".pdf-output [data-save]").isVisible(), false);
    assert.equal(await page.locator("#print-viewport").getAttribute("inert"), null);
    await page.locator("#cors-test-image").evaluate((node) => node.remove());
    await page.locator("#pdf-export").click();
    await page.locator(".pdf-output [data-save]").waitFor({ state: "visible" });
    console.log(`${channel}: CORS failure is explicit; retry succeeds`);
  }
  assert.deepEqual(errors, [], "No browser runtime errors");
} finally {
  await browser?.close();
  await server.close();
  await new Promise((resolve) => corsServer.close(resolve));
}
