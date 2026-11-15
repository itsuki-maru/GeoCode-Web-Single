// ユーザーによる手動受入用。通常は無視されるRustの検証用サーバーを明示起動してから実行する。
// 管理操作は検証用サーバー内のCLIで完了し、ここでは共通画面とXYZだけを使う。
const { chromium } = require(process.env.GEOCODE_PLAYWRIGHT_MODULE || "playwright");
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");

const ready = path.resolve(process.argv[2]);
const root = path.dirname(ready);
const fixture = JSON.parse(fs.readFileSync(ready, "utf8"));
assert.equal(fixture.prepared_by_cli, true, "CLI準備済みの新fixtureを指定してください");
assert.equal(fixture.original_pbf_absent, true);
const dataset = fixture.dataset;
assert.match(dataset.url, /^\/local-tiles\/[a-z0-9-]+\/[a-z0-9-]+\/\{z\}\/\{x\}\/\{y\}\.png$/);
const origin = new URL(fixture.url).origin;
const remote = [];
const errors = [];
const responses = [];
const managementRequests = [];

async function until(check, message) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw Error(message);
}

async function isolate(context) {
  await context.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) {
      remote.push(url.href);
      return route.abort();
    }
    return route.continue();
  });
  context.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/admin/local-tiles")) managementRequests.push(request.url());
  });
}

function recordPage(page) {
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("response", (response) => {
    if (response.url().includes("/local-tiles/") && response.request().resourceType() === "image") {
      responses.push({ url: response.url(), status: response.status() });
    }
  });
}

async function mapLoaded(page) {
  await until(() => page.locator(".leaflet-tile-loaded").evaluateAll(
    (images) => images.length > 0 && images.every((image) => getComputedStyle(image).opacity === "1"),
  ), "通常XYZタイルを使用する地図を表示できませんでした");
}

(async () => {
  const browser = await chromium.launch({
    channel: "msedge", headless: true,
    args: ["--disable-background-networking", "--disable-component-update", "--disable-sync", "--no-first-run"],
  });
  try {
    assert.equal(fs.existsSync(fixture.input_path), false, "元PBFが残っています");
    const context = await browser.newContext({ viewport: { width: 1365, height: 950 } });
    await context.addCookies([{ name: "access_token", value: fixture.access_token, url: origin, httpOnly: true, sameSite: "Lax" }]);
    await isolate(context);
    const page = await context.newPage();
    recordPage(page);
    await page.goto(origin + "/background-maps");
    await page.getByRole("heading", { name: "背景地図設定", exact: true }).waitFor();
    assert.equal(await page.getByRole("link", { name: "ローカル地図", exact: true }).count(), 0);
    await page.getByRole("heading", { name: dataset.label, exact: false }).waitFor();

    // 一時DBの既定背景を、共通画面から通常ラスタURLへ設定する。
    const definitions = await (await context.request.get(origin + "/admin/background-maps")).json();
    assert.ok(definitions.some((row) => row.id === fixture.background_id && row.url === dataset.url));
    const originalDefault = definitions.find((row) => row.id === 1);
    assert.ok(originalDefault);
    await page.getByRole("button", { name: `${originalDefault.label}を編集`, exact: true }).click();
    await page.locator("#background-label").fill("ローカル道路");
    await page.locator("#background-layer-name").fill("fixture-local-default");
    await page.locator("#background-url").fill(dataset.url);
    await page.locator("#background-attribution").fill(dataset.attribution);
    await page.locator("#background-min-zoom").fill("0");
    await page.locator("#background-max-zoom").fill("22");
    await page.locator("#background-foreign").check();
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await page.getByRole("status").filter({ hasText: "背景地図を保存しました" }).waitFor();
    await page.screenshot({ path: path.join(root, "admin-desktop.png"), fullPage: true, animations: "disabled" });

    // 事前生成したPNGをXYZで取得する。専用のプレビューAPIは使わない。
    const z = 14;
    const x = Math.floor(((139.7 + 180) / 360) * 2 ** z);
    const y = Math.floor(((1 - Math.asinh(Math.tan((35.7 * Math.PI) / 180)) / Math.PI) / 2) * 2 ** z);
    const tilePath = dataset.url.replace("{z}", z).replace("{x}", x).replace("{y}", y);
    const tile = await context.request.get(origin + tilePath);
    assert.equal(tile.status(), 200, await tile.text());
    assert.match(tile.headers()["content-type"], /^image\/png/);
    assert.equal(tile.headers()["x-tile-cache"], "HIT");
    const png = await tile.body();
    assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    fs.writeFileSync(path.join(root, "xyz-preview.png"), png);

    await context.addInitScript(() => localStorage.setItem("geocode-web:selected-tile-server-id", "1"));
    const map = await context.newPage();
    recordPage(map);
    await map.goto(origin + "/map?latitude=35.7&longitude=139.7");
    await mapLoaded(map);
    await map.screenshot({ path: path.join(root, "map-desktop.png"), animations: "disabled" });
    await map.emulateMedia({ media: "print" });
    await map.pdf({ path: path.join(root, "map-print.pdf"), printBackground: true });

    const mobileContext = await browser.newContext({
      viewport: { width: 390, height: 844 }, isMobile: true,
      userAgent: "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120.0 Mobile Safari/537.36",
    });
    await mobileContext.addCookies([{ name: "access_token", value: fixture.access_token, url: origin, httpOnly: true, sameSite: "Lax" }]);
    await mobileContext.addInitScript(() => localStorage.setItem("geocode-web:selected-tile-server-id", "1"));
    await isolate(mobileContext);
    const mobile = await mobileContext.newPage();
    recordPage(mobile);
    await mobile.goto(origin + "/map?latitude=35.7&longitude=139.7");
    await mapLoaded(mobile);
    await mobile.screenshot({ path: path.join(root, "map-mobile.png"), animations: "disabled" });

    // 共有スナップショットを保存し、その後に背景が変わっても保存時のXYZ URLを保持する。
    const { id: layer } = await (await context.request.get(origin + "/layer/masterid")).json();
    const layers = await (await context.request.get(origin + "/layer/read/all")).json();
    const rows = await (await context.request.get(origin + "/admin/background-maps")).json();
    const current = rows.find((row) => row.id === 1);
    const tileServer = Object.fromEntries([
      "id", "layer_name", "label", "url", "attribution", "include_foreign_tiles", "min_zoom", "max_zoom", "kind", "style_url",
    ].map((key) => [key, current[key]]));
    const snapshot = {
      version: 2,
      state: {
        view: { latitude: 35.7, longitude: 139.7, zoom: 14 }, tileServerId: "1", overlays: {},
        markersVisible: true, shapesVisible: true, shapeNamesVisible: true,
        layerIds: [layer], markerIds: [], shapeIds: [],
      },
      layers: { [layer]: layers[layer] }, markers: {}, shapes: [], tileServers: { "1": tileServer }, tileOverlays: [],
    };
    const shared = await context.request.post(origin + "/onetimeurl/generate", {
      data: { minutes: 60, layers: [layer], update_url: false, share_password: null, include_shapes: true, include_tile_overlays: false, snapshot },
    });
    assert.equal(shared.status(), 200, await shared.text());
    const { url: shareUrl } = await shared.json();
    const changed = await context.request.put(origin + "/admin/background-maps/1", {
      data: { ...tileServer, url: "/fixture-replaced-background/{z}/{x}/{y}.png" },
    });
    assert.equal(changed.status(), 200, await changed.text());
    const anonymous = await browser.newContext({ viewport: { width: 1200, height: 800 } });
    await isolate(anonymous);
    const share = await anonymous.newPage();
    recordPage(share);
    const retained = [];
    share.on("response", (response) => {
      if (response.url().includes("/local-tiles/") && response.request().resourceType() === "image") retained.push(response.url());
    });
    await share.goto(origin + shareUrl + "?lat=35.7&lng=139.7&zoom=14");
    await mapLoaded(share);
    assert.ok(retained.length > 0, "共有に保存したローカルXYZ URLが利用されていません");
    assert.ok(retained.every((url) => url.startsWith(origin + dataset.url.split("{z}")[0])));
    await share.screenshot({ path: path.join(root, "map-shared.png"), animations: "disabled" });
    const restored = await context.request.put(origin + "/admin/background-maps/1", { data: tileServer });
    assert.equal(restored.status(), 200, await restored.text());

    assert.equal(managementRequests.length, 0, JSON.stringify(managementRequests));
    assert.equal(remote.length, 0, JSON.stringify(remote));
    assert.equal(errors.length, 0, JSON.stringify(errors));
    const summary = {
      success: true, prepared_by_cli: true, original_pbf_absent: !fs.existsSync(fixture.input_path),
      common_background_ui: true, snapshot_retained_original_url: true, desktop_mobile_share_and_print: true,
      management_requests: managementRequests, remote_requests: remote, page_errors: errors,
      tile_response: { url: origin + tilePath, status: tile.status(), cache: tile.headers()["x-tile-cache"] },
      tile_responses: responses, artifacts: root,
    };
    fs.writeFileSync(path.join(root, "summary.json"), JSON.stringify(summary, null, 2));
    console.log(JSON.stringify(summary));
    await context.close();
    await mobileContext.close();
    await anonymous.close();
  } finally {
    await browser.close();
    fs.writeFileSync(path.join(root, "done"), "done");
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
