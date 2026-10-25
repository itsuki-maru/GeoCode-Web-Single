// Called by check-print-preview.mjs --clusters=true. Uses real templates and vendor CSS.
import assert from "node:assert/strict";
import { readFile, mkdir } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createServer } from "vite";

export async function checkAnswerClusters(args) {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const channel = args.browser || "chrome";
  const output = resolve(root, args.output || `dist/cluster-check/${channel}`);
  await mkdir(output, { recursive: true });
  const { chromium } = await import(
    args["playwright-path"] ? pathToFileURL(resolve(args["playwright-path"])).href : "playwright"
  );
  const source = await readFile(resolve(root, "src/templates/form-answer-map.html"), "utf8");
  const view = { latitude: 35.68, longitude: 139.76, zoom: 13 };
  const state = {
    view,
    tileServerId: "1",
    overlays: {},
    markersVisible: true,
    shapesVisible: true,
    shapeNamesVisible: false,
    layerIds: null,
  };
  function template(count, printing, colored) {
    const markers = Object.fromEntries(
      Array.from({ length: count }, (_, i) => [
        `m${i}`,
        {
          id: `m${i}`,
          layer_id: i === count - 1 ? "b" : "a",
          marker_name: `${i === count - 1 ? "対象B" : "対象A"}-${i}`,
          detail: "",
          latitude: view.latitude,
          longitude: view.longitude,
        },
      ]),
    );
    const keys = Object.keys(markers).map((id) => `marker:${id}`);
    const coloring = {
      version: 1,
      rules: [
        { id: "red", label: "50年以上", color: "#d73027" },
        { id: "blue", label: "50年未満", color: "#2166ac" },
      ],
      targets: Object.fromEntries(keys.map((key, i) => [key, i < 9 ? "red" : "blue"])),
    };
    const bootstrap = {
      page: "form-answer-map",
      isCluster: true,
      initialView: view,
      tileServers: {
        1: {
          url: "/cluster-tile.svg",
          attribution: "CLUSTER TEST SOURCE",
          label: "標準",
          layer_name: "標準",
          include_foreign_tiles: true,
          min_zoom: 0,
          max_zoom: 18,
        },
      },
      tileOverlays: [],
      layers: { a: { id: "a", layer_name: "対象レイヤ" }, b: { id: "b", layer_name: "別レイヤ" } },
      markers,
      shapes: [],
      popupBodies: {},
      answerPreview: {
        query: {},
        targets: keys,
        parentOrigin: "http://localhost",
        requestId: "cluster-test",
        targetCount: count,
        answerCount: count,
      },
    };
    return source
      .replace(
        /window\.__GEOCODE_MAP_BOOTSTRAP__ = \{[\s\S]*?\n        \};/,
        `window.__GEOCODE_MAP_BOOTSTRAP__ = ${JSON.stringify(bootstrap)};`,
      )
      .replace(
        '<script type="module" src="/assets/template-form-answer-map.js"></script>',
        `<script type="module">
        import { initializeReadOnlyMapPage } from "/src/map/read-only-page.ts";
        import { installAnswerColoring } from "/src/map/answer-coloring.ts";
        import { createPrintPreview } from "/src/map/print/print-preview.ts";
        const coloring = ${JSON.stringify(coloring)};
        const runtime = ${printing ? `createPrintPreview(${JSON.stringify(state)}, () => {}, "form-answer-map", undefined, ${colored ? "coloring" : "undefined"})` : 'initializeReadOnlyMapPage("form-answer-map")'};
        const map = runtime.map;
        let group; map.eachLayer(layer => { if (layer instanceof L.MarkerClusterGroup) group = layer; });
        window.clusterCheck = { runtime, map, group, coloring, original: group.options.iconCreateFunction, keys: ${JSON.stringify(keys)} };
        ${printing ? "" : "window.clusterCheck.color = installAnswerColoring(runtime, L);"}
        document.documentElement.dataset.clusterReady = "true";
      </script>`,
      );
  }
  const server = await createServer({
    root: resolve(root, "src_frontend/template-scripts"),
    configFile: false,
    publicDir: false,
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0 },
    plugins: [
      {
        name: "answer-cluster-fixture",
        configureServer(vite) {
          vite.middlewares.use(async (req, res, next) => {
            const url = new URL(req.url, "http://localhost");
            if (url.pathname === "/cluster-check.html") {
              const count = Number(url.searchParams.get("count") || "100");
              res.setHeader("Content-Type", "text/html; charset=utf-8");
              res.end(
                template(
                  [9, 10, 99, 100].includes(count) ? count : 100,
                  url.searchParams.has("print"),
                  url.searchParams.has("colored"),
                ),
              );
              return;
            }
            if (url.pathname === "/cluster-tile.svg") {
              res.setHeader("Content-Type", "image/svg+xml");
              res.end(
                '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#e8eedf"/><path d="M0 70H256M80 0V256M0 200H256" stroke="white" stroke-width="8"/></svg>',
              );
              return;
            }
            if (url.pathname.startsWith("/assets/")) {
              const name = basename(url.pathname);
              try {
                res.setHeader(
                  "Content-Type",
                  { ".js": "text/javascript", ".css": "text/css", ".png": "image/png" }[
                    extname(name)
                  ] || "application/octet-stream",
                );
                res.end(await readFile(resolve(root, "src_frontend/frontend/dist", name)));
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
  let browser;
  await server.listen();
  try {
    browser = await chromium.launch({ channel, headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const url = `http://127.0.0.1:${server.httpServer.address().port}/cluster-check.html`;
    const snapshot = () =>
      page.evaluate(() => {
        const element = document.querySelector(".marker-cluster");
        if (!element) return null;
        const style = getComputedStyle(element),
          inner = element.querySelector("div");
        return {
          className: element.className,
          count: element.textContent,
          width: style.width,
          height: style.height,
          background: style.backgroundColor,
          innerBackground: getComputedStyle(inner).backgroundColor,
          original: clusterCheck.group.options.iconCreateFunction === clusterCheck.original,
        };
      });
    const check = async (count) => {
      await page.waitForFunction(
        (value) => document.querySelector(".marker-cluster")?.textContent === String(value),
        count,
      );
      const actual = await snapshot();
      assert.ok(
        actual.className.includes(
          `marker-cluster-${count < 10 ? "small" : count < 100 ? "medium" : "large"}`,
        ),
      );
      assert.equal(actual.width, "40px");
      assert.equal(actual.height, "40px");
      assert.equal(actual.original, true);
      assert.equal(await page.locator(".answer-neutral-cluster").count(), 0);
      return actual;
    };
    for (const count of [9, 10, 99, 100]) {
      await page.goto(`${url}?count=${count}`);
      await page.waitForSelector('[data-cluster-ready="true"]');
      const before = await check(count);
      await page.evaluate(() => clusterCheck.color.apply(clusterCheck.coloring));
      assert.deepEqual(await check(count), before);
      await page.screenshot({ path: resolve(output, `colored-${count}.png`), fullPage: true });
      await page.evaluate(() =>
        clusterCheck.color.apply({
          ...clusterCheck.coloring,
          rules: clusterCheck.coloring.rules.map((rule) => ({ ...rule, color: "#009e73" })),
        }),
      );
      assert.deepEqual(await check(count), before);
      await page.evaluate(() => clusterCheck.color.apply(null));
      assert.deepEqual(await check(count), before);
      console.log(
        `${channel}: ${count} markers retain standard cluster color, size and count before/after coloring`,
      );
    }
    await page.evaluate(() => clusterCheck.color.apply(clusterCheck.coloring));
    const center = await page.evaluate(() => ({
      center: clusterCheck.map.getCenter(),
      zoom: clusterCheck.map.getZoom(),
    }));
    await page.evaluate(() => clusterCheck.runtime.setLegendHiddenTargets(["marker:m0"]));
    await check(99);
    await page.evaluate(() => clusterCheck.runtime.setLegendHiddenTargets([]));
    await check(100);
    await page.locator("#marker-search-input").fill("対象A");
    await check(99);
    await page.evaluate(() => clusterCheck.runtime.setLegendHiddenTargets(["marker:m0"]));
    await check(98);
    await page.evaluate(() => clusterCheck.runtime.setLegendHiddenTargets([]));
    await check(99);
    await page.locator("#marker-search-input").fill("");
    await check(100);
    await page.getByRole("checkbox", { name: "別レイヤ", exact: true }).uncheck();
    await check(99);
    await page.evaluate(() => {
      clusterCheck.runtime.setLegendHiddenTargets(["marker:m0"]);
      clusterCheck.runtime.setLegendHiddenTargets([]);
    });
    await check(99);
    await page.getByRole("checkbox", { name: "別レイヤ", exact: true }).check();
    await check(100);
    assert.deepEqual(
      await page.evaluate(() => ({
        center: clusterCheck.map.getCenter(),
        zoom: clusterCheck.map.getZoom(),
      })),
      center,
    );
    await page.evaluate(() => {
      clusterCheck.map.setZoom(18, { animate: false });
    });
    // Leaflet's non-animated zoom still lets MarkerCluster animate its split.
    // MarkerCluster 1.5.3 deliberately ignores spiderfy() during that animation.
    await page.waitForFunction(() => {
      const { map, group } = clusterCheck;
      const parent = group.getVisibleParent(group.getLayers()[0]);
      return (
        map.getZoom() === 18 &&
        group._inZoomAnimation === 0 &&
        typeof parent?.spiderfy === "function"
      );
    });
    await page.evaluate(() => {
      const { group } = clusterCheck;
      clusterCheck.spiderfied = false;
      group.once("spiderfied", () => {
        clusterCheck.spiderfied = true;
      });
      group.getVisibleParent(group.getLayers()[0]).spiderfy();
    });
    try {
      await page.waitForFunction(
        () =>
          clusterCheck.spiderfied &&
          document.querySelectorAll(".answer-value-marker").length === 100,
      );
    } catch (error) {
      console.error(
        await page.evaluate(() => ({
          zoom: clusterCheck.map.getZoom(),
          animation: clusterCheck.group._inZoomAnimation,
          spiderfiedEvent: clusterCheck.spiderfied,
          childCount: clusterCheck.group.getLayers().length,
          coloredElements: document.querySelectorAll(".answer-value-marker").length,
          iconClasses: [
            ...new Set(
              clusterCheck.group.getLayers().map((marker) => marker.options.icon.options.className),
            ),
          ],
        })),
      );
      await page.screenshot({ path: resolve(output, "spiderfy-error.png"), fullPage: true });
      throw error;
    }
    const colors = await page
      .locator(".answer-value-marker > span")
      .evaluateAll((nodes) =>
        [...new Set(nodes.map((node) => getComputedStyle(node).backgroundColor))].sort(),
      );
    assert.deepEqual(colors, ["rgb(215, 48, 39)", "rgb(33, 102, 172)"]);
    await page.screenshot({
      path: resolve(output, "spiderfied-classification-colors.png"),
      fullPage: true,
    });

    let baseline;
    for (const colored of [false, true]) {
      await page.goto(`${url}?count=100&print=1${colored ? "&colored=1" : ""}`);
      await page.waitForSelector('[data-cluster-ready="true"]');
      const actual = await check(100);
      if (!colored) baseline = actual;
      else assert.deepEqual(actual, baseline);
      await page.waitForFunction(() => !document.querySelector("#print-submit").disabled);
      await page.screenshot({
        path: resolve(output, `print-${colored ? "colored" : "ordinary"}.png`),
        fullPage: true,
      });
      if (colored) {
        await page.getByRole("checkbox", { name: "50年未満", exact: true }).uncheck();
        await page.getByRole("checkbox", { name: "地図と連動", exact: true }).check();
        await check(9);
        await page.getByRole("checkbox", { name: "50年未満", exact: true }).check();
        await check(100);
        await page.waitForFunction(() => !document.querySelector("#print-submit").disabled);
        await page.pdf({
          path: resolve(output, "colored-cluster-print.pdf"),
          preferCSSPageSize: true,
          printBackground: true,
        });
        // afterprint restarts the settling check. Wait for both buttons to be
        // refreshed before clicking PDF; a stale enabled button can ignore clicks.
        await page.waitForFunction(
          () =>
            !document.querySelector("#print-submit").disabled &&
            !document.querySelector("#pdf-export").disabled,
        );
        await page.locator("#pdf-export").click();
        try {
          await page
            .locator(".pdf-output [data-save]")
            .waitFor({ state: "visible", timeout: 30000 });
        } catch (error) {
          console.error(await page.locator("#print-status").innerText());
          console.error(await page.locator(".pdf-output").innerText());
          console.error(errors);
          await page.screenshot({ path: resolve(output, "cluster-pdf-error.png"), fullPage: true });
          throw error;
        }
        const download = page.waitForEvent("download");
        await page.locator(".pdf-output [data-save]").click();
        await (await download).saveAs(resolve(output, "colored-cluster-client.pdf"));
      }
    }
    assert.deepEqual(errors, [], "No runtime errors during cluster checks");
    console.log(
      `${channel}: search/layers/legend masks, spiderfied colors and print/PDF clusters verified`,
    );
  } finally {
    await browser?.close();
    await server.close();
  }
}
