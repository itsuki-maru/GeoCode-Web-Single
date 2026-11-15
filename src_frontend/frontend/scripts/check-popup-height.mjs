// PC通常地図・全画面地図のポップアップを実際のLeafletで確認する。
// --playwright-path=<index.mjs> で同梱ランタイム、--browser=chrome|msedge でブラウザーを指定できる。
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => arg.replace(/^--/, "").split(/=(.*)/s, 2)),
);
const { chromium } = await import(
  args["playwright-path"] ? pathToFileURL(resolve(args["playwright-path"])).href : "playwright"
);
const output = resolve(root, "target/popup-height");
await mkdir(output, { recursive: true });
const scriptJson = (value) => JSON.stringify(value).replace(/</g, "\\u003c");
const paragraphs = Array.from({ length: 60 }, (_, i) => `確認用の本文 ${i + 1}。`).join("\n\n");
const body = `:::details 画像と追記の確認\n![確認用画像](/static/images/popup-height.svg)\n\n${paragraphs}\n:::\n\n${paragraphs}`;
const asciiTitle = "A".repeat(40);
const marker = {
  id: "test-marker",
  marker_name: "高さの確認用マーカー",
  latitude: 35.6812,
  longitude: 139.7671,
  layer_id: "test-layer",
  detail: body,
};
const baseBootstrap = {
  dataSource: "server",
  page: "map",
  selectedLayer: "test-layer",
  isMaster: true,
  markerId: "0",
  isCluster: true,
  shareParentOrigins: [],
  initialView: { latitude: marker.latitude, longitude: marker.longitude, zoom: 16 },
  tileServers: {
    1: {
      id: 1,
      label: "確認用背景",
      layer_name: "test",
      url: "/tiles/{z}/{x}/{y}.png",
      min_zoom: 1,
      max_zoom: 18,
      include_foreign_tiles: true,
      attribution: "test",
    },
  },
  tileOverlays: [],
  tileVisibilityAccountId: "popup-height-check",
  layers: { "test-layer": { id: "test-layer", layer_name: "確認用レイヤー", is_master: false } },
  markers: { "test-marker": marker },
  shapes: [],
};
const templates = Object.fromEntries(
  await Promise.all(
    ["map", "map-anather"].map(async (name) => [
      name,
      (await readFile(resolve(root, `src/templates/${name}.html`), "utf8")).replace(/\r\n/g, "\n"),
    ]),
  ),
);
const assets = {
  "leaflet.js": "src_frontend/frontend/node_modules/leaflet/dist/leaflet.js",
  "leaflet.css": "src_frontend/frontend/node_modules/leaflet/dist/leaflet.css",
  "leaflet.markercluster.js":
    "src_frontend/frontend/node_modules/leaflet.markercluster/dist/leaflet.markercluster.js",
  "MarkerCluster.css":
    "src_frontend/frontend/node_modules/leaflet.markercluster/dist/MarkerCluster.css",
  "MarkerCluster.Default.css":
    "src_frontend/frontend/node_modules/leaflet.markercluster/dist/MarkerCluster.Default.css",
  "marked.min.js": "src_frontend/frontend/node_modules/marked/lib/marked.umd.js",
  "xss.min.js": "src_frontend/frontend/node_modules/xss/dist/xss.min.js",
  "map-compat.css": "src_frontend/frontend/public/map-compat.css",
  "map-controls.css": "src_frontend/frontend/public/map-controls.css",
  "popup-content.css": "src_frontend/template-scripts/public/popup-content.css",
  "marker.png": "src_frontend/frontend/public/marker.png",
};
const captureRuntime = (fullscreen) => `
${fullscreen ? "" : "const runtime = {map, markers, visibleMarkerGroup:markersClusterGroup};"}
const testMarker = runtime.markers['marker-test-marker'];
window.popupCheck = {map:runtime.map,marker:testMarker,events:[],focus:()=>{
 ${
   fullscreen
     ? "runtime.map.setView(testMarker.getLatLng(),16);runtime.visibleMarkerGroup.zoomToShowLayer(testMarker,()=>testMarker.openPopup());"
     : "focusMapObject('marker','test-marker',35.6812,139.7671);"
 }
},${
  fullscreen
    ? `prepare:async()=>{
 if(!runtime.map.hasLayer(runtime.visibleMarkerGroup))runtime.visibleMarkerGroup.addTo(runtime.map);
 Object.values(layerVisibilityGroups).forEach(group=>group.addTo(runtime.map));
 await objectLoader?.load('test-layer');
}`
    : ""
}};
for(const type of ['popupopen','popupclose','autopanstart']) runtime.map.on(type,(event)=>{
 if(event.popup && event.popup!==testMarker.getPopup())return;
 const el=testMarker.getPopup().getElement();
 window.popupCheck.events.push({type,popupHeight:el?.offsetHeight,bodyHeight:el?.querySelector('.popup-content-body')?.offsetHeight});
});
window.popupCheck.ready=true;
`;
function frameHtml(url) {
  const fullscreen = url.searchParams.get("view") === "fullscreen";
  const name = fullscreen ? "map-anather" : "map";
  const bootstrap = {
    ...baseBootstrap,
    page: name,
    markers: {
      "test-marker": {
        ...marker,
        marker_name: url.searchParams.has("ascii")
          ? asciiTitle
          : url.searchParams.has("long")
            ? "折り返しのある長いマーカー名と高さを確認します。".repeat(
                Number(url.searchParams.get("long")),
              )
            : marker.marker_name,
        detail: url.searchParams.has("short") ? "短い本文です。" : body,
      },
    },
  };
  const template = templates[name];
  const cut = template.indexOf("    <script>\n        window.__GEOCODE_MAP_BOOTSTRAP__");
  assert.ok(cut >= 0, `${name}: bootstrap boundary`);
  return (
    template.slice(0, cut) +
    `<script>
window.__GEOCODE_MAP_BOOTSTRAP__=${scriptJson(bootstrap)};
var {selectedLayer:layer,isMaster:is_master,markerId,tileServers,layers:layersFromAxum,markers:markersFromAxum,shapes:shapesFromAxum}=window.__GEOCODE_MAP_BOOTSTRAP__;
var {latitude,longitude,zoom}=window.__GEOCODE_MAP_BOOTSTRAP__.initialView;
</script><script type="module" src="${fullscreen ? "/src/entries/map-anather.ts" : "/@id/virtual:geocode-editor:map"}"></script></html>`
  );
}
const server = await createServer({
  root: resolve(root, "src_frontend/template-scripts"),
  configFile: resolve(root, "src_frontend/template-scripts/vite.config.ts"),
  logLevel: "error",
  server: { host: "127.0.0.1", port: 0 },
  plugins: [
    {
      name: "popup-height-check",
      enforce: "post",
      transform(code, id) {
        if (id === "\0virtual:geocode-editor:map") return code + captureRuntime(false);
        if (id.split("?")[0].replaceAll("\\", "/").endsWith("/src/map/read-only-page.ts"))
          return code.replace("return runtime;", captureRuntime(true) + "return runtime;");
      },
      configureServer(vite) {
        vite.middlewares.use(async (req, res, next) => {
          const url = new URL(req.url, "http://localhost");
          if (url.pathname === "/check") {
            const full = url.searchParams.get("view") === "fullscreen";
            res.setHeader("Content-Type", "text/html; charset=utf-8");
            res.end(
              `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0"><iframe id="map-frame" src="/frame?${url.searchParams}" style="display:block;border:0;width:100%;height:${full ? "95vh;padding:16px;box-sizing:border-box" : "82vh"}"></iframe><script>function fit(){if(${full})return;document.querySelector('iframe').style.height=innerHeight>=innerWidth?(innerHeight>947?'88vh':'87vh'):(innerHeight>947?'83vh':'82vh')}fit();addEventListener('resize',fit)</script></body></html>`,
            );
          } else if (url.pathname === "/frame") {
            res.setHeader("Content-Type", "text/html; charset=utf-8");
            res.end(frameHtml(url));
          } else if (url.pathname.startsWith("/assets/")) {
            const path = assets[url.pathname.slice(8)];
            if (!path) {
              res.statusCode = 204;
              res.end();
              return;
            }
            res.setHeader(
              "Content-Type",
              path.endsWith(".css")
                ? "text/css"
                : path.endsWith(".png")
                  ? "image/png"
                  : "text/javascript",
            );
            res.end(await readFile(resolve(root, path)));
          } else if (url.pathname === "/static/images/popup-height.svg") {
            res.setHeader("Content-Type", "image/svg+xml");
            res.end(
              '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200"><rect width="320" height="200" fill="navy"/></svg>',
            );
          } else if (url.pathname === "/marker/read/all" || url.pathname === "/shapes") {
            res.setHeader("Content-Type", "application/json");
            res.end(url.pathname === "/shapes" ? "[]" : "{}");
          } else if (url.pathname.startsWith("/tiles/")) {
            res.setHeader("Content-Type", "image/png");
            res.end(
              Buffer.from(
                "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
                "base64",
              ),
            );
          } else if (url.pathname === "/tile-proxy-revision.js") {
            res.setHeader("Content-Type", "text/javascript");
            res.end("");
          } else next();
        });
      },
    },
  ],
});

async function snapshot(frame) {
  return frame.evaluate(() => {
    const { map, marker, events } = window.popupCheck;
    const popup = marker.getPopup().getElement();
    const mapRect = map.getContainer().getBoundingClientRect();
    const popupRect = popup.getBoundingClientRect();
    const content = popup.querySelector(".geocode-content-popup");
    const body = popup.querySelector(".popup-content-body");
    const point = map.latLngToContainerPoint(marker.getLatLng());
    return {
      open: marker.isPopupOpen(),
      markerPresent: map.hasLayer(marker),
      mapHeight: map.getSize().y,
      markerX: point.x,
      markerY: point.y,
      mapWidth: map.getSize().x,
      popupTop: popupRect.top - mapRect.top,
      popupHeight: popupRect.height,
      bodyHeight: body?.getBoundingClientRect().height,
      bodyWidth: body?.getBoundingClientRect().width,
      rootWidth: content?.getBoundingClientRect().width,
      parentWidth: content?.parentElement.getBoundingClientRect().width,
      rootHeight: content?.clientHeight,
      rootScrollHeight: content?.scrollHeight,
      rootScrollTop: content?.scrollTop,
      scrollTop: body?.scrollTop,
      note: popup.querySelector(".popup-content-note")?.textContent,
      events,
    };
  });
}
function checkVisible(value, name) {
  assert.equal(value.open, true, `${name}: popup remains open ${JSON.stringify(value)}`);
  assert.equal(value.markerPresent, true, `${name}: marker remains rendered`);
  assert.ok(
    value.bodyHeight > 0 && value.bodyHeight <= 500.5,
    `${name}: body height ${value.bodyHeight}`,
  );
  assert.ok(
    value.markerY >= 0 && value.markerY <= value.mapHeight,
    `${name}: marker Y ${value.markerY}/${value.mapHeight}`,
  );
  assert.ok(value.markerX >= 0 && value.markerX <= value.mapWidth, `${name}: marker X`);
  assert.ok(value.popupTop >= -1, `${name}: popup top ${value.popupTop}`);
  assert.equal(
    value.events.some(({ type }) => type === "popupclose"),
    false,
    `${name}: never closes transiently`,
  );
}

let browser;
const results = [];
try {
  await server.listen();
  browser = await chromium.launch({ channel: args.browser || "chrome", headless: true });
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  const cases = [
    { name: "normal-1133x744", width: 1133, height: 744 },
    { name: "normal-1024x768", width: 1024, height: 768 },
    { name: "normal-long-title", width: 1133, height: 744, long: true, held: true },
    { name: "normal-body-error", width: 1133, height: 744, failed: true },
    { name: "normal-rotation", width: 744, height: 1133, rotate: true },
    { name: "fullscreen-1133x744", width: 1133, height: 744, fullscreen: true },
    {
      name: "fullscreen-long-title-error",
      width: 1024,
      height: 768,
      fullscreen: true,
      long: true,
      failed: true,
    },
    {
      name: "fullscreen-desktop",
      width: 1920,
      height: 1080,
      fullscreen: true,
      desktop: true,
      rotate: true,
    },
    { name: "normal-short-body", width: 1133, height: 744, short: true },
    {
      name: "fullscreen-short-body",
      width: 1920,
      height: 1080,
      fullscreen: true,
      desktop: true,
      short: true,
    },
    { name: "normal-low-height-long-title", width: 1133, height: 500, long: 12, boundary: true },
    {
      name: "fullscreen-low-height-long-title",
      width: 1133,
      height: 500,
      long: 12,
      boundary: true,
      fullscreen: true,
    },
    {
      name: "normal-ascii-title-with-other-popup",
      width: 1133,
      height: 744,
      ascii: true,
      coexist: true,
    },
    {
      name: "fullscreen-ascii-title-with-other-popup",
      width: 1133,
      height: 744,
      fullscreen: true,
      ascii: true,
      coexist: true,
    },
  ];
  for (const test of cases) {
    const context = await browser.newContext({
      viewport: { width: test.width, height: test.height },
      isMobile: !test.desktop,
      hasTouch: !test.desktop,
    });
    await context.addInitScript(() =>
      Object.defineProperty(navigator, "geolocation", { value: undefined, configurable: true }),
    );
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    await page.route("**/marker/test-marker/form/body", async (route) => {
      if (test.held) await gate;
      const testBody = test.short ? "短い本文です。" : body;
      await route.fulfill({
        status: test.failed ? 500 : 200,
        contentType: "application/json",
        body: JSON.stringify({
          body: testBody,
          free_text: testBody,
          managed_markdown: testBody,
          sync_required: false,
        }),
      });
    });
    let frame;
    try {
      const params = new URLSearchParams({
        view: test.fullscreen ? "fullscreen" : "normal",
        ...(test.long ? { long: String(typeof test.long === "number" ? test.long : 4) } : {}),
        ...(test.short ? { short: "1" } : {}),
        ...(test.ascii ? { ascii: "1" } : {}),
      });
      await page.goto(`${origin}/check?${params}`);
      frame = page.frames().find((candidate) => new URL(candidate.url()).pathname === "/frame");
      await frame.waitForFunction(() => window.popupCheck?.ready, {}, { timeout: 20000 });
      await frame.evaluate(() => window.popupCheck.prepare?.());
      await frame.evaluate(() => window.popupCheck.focus());
      await page.waitForTimeout(700);
      const first = await snapshot(frame);
      checkVisible(first, test.name);
      if (test.ascii) {
        const title = await frame.evaluate(() => {
          const title = document.querySelector(".popup-content-title");
          const range = document.createRange();
          range.selectNodeContents(title);
          return {
            text: title.textContent,
            width: title.clientWidth,
            scrollWidth: title.scrollWidth,
            lineCount: range.getClientRects().length,
          };
        });
        assert.equal(title.text, asciiTitle, `${test.name}: retains full title`);
        assert.ok(title.lineCount >= 2, `${test.name}: wraps an unbroken title`);
        assert.ok(
          title.scrollWidth <= title.width + 1,
          `${test.name}: title has no clipped horizontal overflow`,
        );
      }
      if (test.coexist) {
        const counts = await frame.evaluate(() => {
          const { map, marker } = window.popupCheck;
          const popup = marker.getPopup();
          const other = L.popup({
            autoClose: false,
            closeOnClick: false,
            autoPan: false,
            className: "shape-name-editor-popup",
          })
            .setLatLng(map.getCenter())
            .setContent("図形名編集ポップアップの共存確認")
            .addTo(map);
          const markerUpdate = popup.update;
          const otherUpdate = other.update;
          let markerUpdates = 0;
          let otherUpdates = 0;
          popup.update = function (...args) {
            markerUpdates += 1;
            return markerUpdate.apply(this, args);
          };
          other.update = function (...args) {
            otherUpdates += 1;
            return otherUpdate.apply(this, args);
          };
          const resize = () =>
            map.fire("resize", {
              oldSize: map.getSize(),
              newSize: map.getSize(),
            });
          try {
            resize();
            const during = { markerUpdates, otherUpdates, otherOpen: other.isOpen() };
            other.remove();
            resize();
            return {
              during,
              after: { markerUpdates, otherUpdates, otherOpen: other.isOpen() },
              markerOpen: marker.isPopupOpen(),
            };
          } finally {
            popup.update = markerUpdate;
            other.update = otherUpdate;
            other.remove();
          }
        });
        assert.equal(counts.during.otherOpen, true, `${test.name}: popups coexist`);
        assert.equal(
          counts.during.markerUpdates,
          1,
          `${test.name}: tracks marker during coexistence`,
        );
        assert.equal(
          counts.during.otherUpdates,
          0,
          `${test.name}: leaves other popup layout alone`,
        );
        assert.equal(counts.after.otherOpen, false, `${test.name}: closes only other popup`);
        assert.equal(
          counts.after.markerUpdates,
          2,
          `${test.name}: keeps tracking after other closes`,
        );
        assert.equal(
          counts.after.otherUpdates,
          0,
          `${test.name}: does not update the closed popup`,
        );
        assert.equal(counts.markerOpen, true, `${test.name}: marker remains open`);
        checkVisible(await snapshot(frame), `${test.name}/coexistence`);
      }
      if (test.held) {
        assert.match(first.note, /確認しています/);
        release();
        await frame.waitForFunction(
          () => document.querySelector(".popup-content-note")?.textContent === "",
        );
      }
      if (test.failed) assert.match(first.note, /取得できない/);
      if (!test.failed) {
        for (const mode of ["free", "answers", "normal"]) {
          await frame.locator(".popup-content-toolbar select").selectOption(mode);
          await page.waitForTimeout(350);
          checkVisible(await snapshot(frame), `${test.name}/${mode}`);
        }
        if (!test.short && !test.boundary) {
          await frame.locator(".popup-content-body details summary").click();
          await frame.waitForFunction(() => {
            const image = document.querySelector(".popup-content-body details img");
            return image?.complete && image.naturalWidth > 0;
          });
          await page.waitForTimeout(350);
          checkVisible(await snapshot(frame), `${test.name}/details-image`);
          const previous = await frame.evaluate(() => {
            const body = document.querySelector(".popup-content-body");
            body.scrollTop = 120;
            body.dispatchEvent(new Event("geocode:contentchange", { bubbles: true }));
            return body.scrollTop;
          });
          await page.waitForTimeout(100);
          assert.ok(
            Math.abs((await snapshot(frame)).scrollTop - previous) < 1,
            `${test.name}: retains scroll`,
          );
        }
      }
      if (test.short) {
        const naturalHeight = await frame.evaluate(() => {
          const body = document.querySelector(".popup-content-body");
          const previous = body.style.cssText;
          body.style.maxHeight = "none";
          body.style.minHeight = "0";
          body.style.flexShrink = "0";
          const height = body.getBoundingClientRect().height;
          body.style.cssText = previous;
          return height;
        });
        assert.ok(
          Math.abs((await snapshot(frame)).bodyHeight - naturalHeight) < 1,
          `${test.name}: short content retains natural height`,
        );
      }
      if (test.boundary) {
        const before = await snapshot(frame);
        assert.ok(
          before.rootScrollHeight > before.rootHeight,
          `${test.name}: long header scrolls inside popup`,
        );
        const reached = await frame.evaluate(() => {
          const root = document.querySelector(".geocode-content-popup");
          const body = root.querySelector(".popup-content-body");
          root.scrollTop = root.scrollHeight;
          const rootRect = root.getBoundingClientRect();
          const bodyRect = body.getBoundingClientRect();
          return {
            rootScrollTop: root.scrollTop,
            visible: bodyRect.bottom > rootRect.top && bodyRect.top < rootRect.bottom,
          };
        });
        assert.ok(reached.visible, `${test.name}: root scroll reaches body`);
        assert.ok(reached.rootScrollTop > 0, `${test.name}: root scrolled`);
        await frame.evaluate(() =>
          document
            .querySelector(".popup-content-body")
            .dispatchEvent(new Event("geocode:contentchange", { bubbles: true })),
        );
        await page.waitForTimeout(100);
        const after = await snapshot(frame);
        assert.ok(
          Math.abs(after.rootScrollTop - reached.rootScrollTop) < 1,
          `${test.name}: retains root scroll after content update`,
        );
        await page.setViewportSize({ width: 1133, height: 480 });
        await page.waitForTimeout(800);
        const resized = await snapshot(frame);
        checkVisible(resized, `${test.name}/resize`);
        assert.ok(resized.rootScrollTop > 0, `${test.name}: retains root scroll after resize`);
      }
      if (test.rotate) {
        const large = await snapshot(frame);
        if (test.desktop)
          assert.ok(
            Math.abs(large.bodyHeight - 500) < 1,
            `${test.name}: caps large screen at 500px`,
          );
        await page.setViewportSize({ width: 1133, height: 744 });
        await page.waitForTimeout(800);
        const small = await snapshot(frame);
        checkVisible(small, `${test.name}/resize-smaller`);
        await page.setViewportSize({ width: 744, height: 1133 });
        await page.waitForTimeout(800);
        checkVisible(await snapshot(frame), `${test.name}/resize-taller`);
      }
      assert.deepEqual(errors, [], `${test.name}: browser errors`);
      const final = await snapshot(frame);
      results.push({ name: test.name, ...final });
      await page.screenshot({ path: resolve(output, `${test.name}.png`), animations: "disabled" });
      console.log(
        `${test.name}: OK (map=${final.mapHeight}px, body=${Math.round(final.bodyHeight)}px, markerY=${Math.round(final.markerY)}px; root/body/parent width=${final.rootWidth}/${final.bodyWidth}/${final.parentWidth})`,
      );
    } catch (error) {
      await page.screenshot({
        path: resolve(output, `${test.name}-failure.png`),
        animations: "disabled",
      });
      if (frame)
        console.error(JSON.stringify(await snapshot(frame).catch(() => ({ errors })), null, 2));
      throw error;
    } finally {
      release();
      await context.close();
    }
  }
} finally {
  await writeFile(resolve(output, "results.json"), JSON.stringify(results, null, 2));
  await browser?.close();
  await server.close();
}
