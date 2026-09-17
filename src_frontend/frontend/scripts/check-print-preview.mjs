// Render the real map template with local test tiles, including its shared CSS.
// Prerequisite: npm run build in frontend. Playwright is an optional QA dependency.
// Example: node scripts/check-print-preview.mjs --browser=chrome --playwright-path=/path/to/playwright/index.mjs
// Add --popup=marker or --popup=shape to check popup content, and --pdf=client for PDF export.
// Verify page counts/content with: python scripts/check-print-preview-pdfs.py ../../dist/print-check/chrome
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
let template = await readFile(resolve(root, "src/templates/map-anather.html"), "utf8");
template = template.replace(
  /window\.__GEOCODE_MAP_BOOTSTRAP__ = \{[\s\S]*?\n        \};/,
  `window.__GEOCODE_MAP_BOOTSTRAP__ = ${JSON.stringify(bootstrap)};`,
);
template = template.replace(
  '<script type="module" src="/assets/template-map-anather.js"></script>',
  `<script type="module">
  import { createPrintPreview } from "/src/map/print/print-preview.ts";
  window.printTestMap = createPrintPreview(${JSON.stringify(state)}, () => {}).map;
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
  for (const paper of ["a4-portrait", "a4-landscape", "a3-portrait", "a3-landscape", "b5-portrait", "b5-landscape"]) {
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
      await page.waitForFunction(() => !document.querySelector("#print-submit").disabled);
      if (args.pdf === "client") {
        if (args.popup) assert.equal(await page.locator(".pdf-output [data-save]").isVisible(), false);
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
        if (args.popup) assert.equal(await page.locator(".leaflet-popup-content").isVisible(), true);
        await page.screenshot({
          path: resolve(output, `client-${paper}-${titled ? "title" : "blank"}-preview.png`),
          fullPage: true,
        });
        console.log(`${channel}: client PDF ${paper} ${titled}`);
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
    // A displayed cross-origin image without CORS must fail explicitly, never
    // produce a seemingly successful PDF with a missing map image.
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
