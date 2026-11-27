// 同梱フロント・本番CSP・模擬Tauri IPCで、サーバーを起動せず経路タブを検証する。
const { chromium } = require(process.env.GEOCODE_PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
const { readFileSync } = require('node:fs');

const root = path.resolve(__dirname, '../..');
const manager = path.join(root, 'tile-manager');
const assets = path.resolve(root, process.env.GEOCODE_FRONTEND_DIST || 'dist', 'assets');
const origin = 'http://tile-manager.localhost';
const desktop = readFileSync(path.join(root, 'src/tile_manager/desktop.rs'), 'utf8');
const csp = desktop.match(/const CSP: &str = "([^"]+)";/)[1];
const dataset = 'a'.repeat(64), profile = 'b'.repeat(64), source = 'c'.repeat(64);
const snapshot = { configured: true, owner_available: false, jobs: [], requests: [],
  datasets: [{ id: dataset, name: '背景', profiles: [{ id: profile }], info: { source_sha256: source,
    attribution: { text: '© OpenStreetMap contributors', additional: [['国土地理院（標高データを加工）', '']] } } }],
  routing: { datasets: [{ id: 'test-graph', name: '経路用', info: { source_sha256: source, edge_count: 2, node_count: 3,
    bounds: { west: 139.6, south: 35.6, east: 139.8, north: 35.7 }, attribution: '© OpenStreetMap contributors' } }] },
};

async function main() {
  const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--disable-background-networking'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1180, height: 860 } });
    const unexpected = [], errors = [], tileRequests = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin === origin) {
        const html = url.pathname === '/index.html';
        const name = url.pathname.slice(1);
        if (html || ['app.js', 'paths.js', 'routes.js', 'style.css', 'assets/leaflet.js', 'assets/leaflet.css'].includes(name)) {
          const file = name.startsWith('assets/') ? path.join(assets, path.basename(name)) : path.join(manager, name);
          return route.fulfill({ status: 200, headers: { 'Content-Security-Policy': csp },
            contentType: html ? 'text/html; charset=utf-8' : name.endsWith('.js') ? 'text/javascript' : 'text/css',
            body: readFileSync(file) });
        }
        if (url.pathname.startsWith('/preview/' + dataset + '/' + profile + '/')) {
          tileRequests.push(url.pathname);
          return route.fulfill({ status: 404, body: '' });
        }
      }
      unexpected.push(url.href);
      return route.abort();
    });
    await page.addInitScript(({ snapshot }) => {
      window.fixtureQueries = [];
      window.fixtureCsp = [];
      document.addEventListener('securitypolicyviolation', event => window.fixtureCsp.push(event.violatedDirective));
      window.__TAURI__ = { core: { invoke: async (command, args) => {
        if (command === 'tile_manager_snapshot') return snapshot;
        if (command === 'tile_manager_query' && args.action === 'route_search') {
          window.fixtureQueries.push(args.payload);
          const { start, end } = args.payload;
          return { geometry: [start, end], snapped_start: start, snapped_end: end, distance_m: 1234, duration_s: 150 };
        }
        throw Error('予期しないIPC: ' + command);
      } } };
    }, { snapshot });
    await page.goto(origin + '/index.html');
    await page.locator('button[data-view="routes"]').click();
    const map = page.locator('#route-map');
    await map.click({ position: { x: 120, y: 120 } });
    await map.click({ position: { x: 220, y: 220 } });
    await page.locator('#route-search').click();
    await page.locator('#route-result').waitFor({ state: 'visible' });
    assert.match(await page.locator('#route-summary').innerText(), /自動車.*1.2 km/);
    assert.ok(await map.locator('svg path').count() >= 5);
    await page.locator('#route-to-precompute').click();
    assert.equal(await page.locator('#precompute-dataset').inputValue(), dataset);
    assert.equal(await page.locator('#precompute-profile').inputValue(), profile);
    await page.locator('button[data-view="routes"]').click();
    await page.locator('#route-background').selectOption('');
    await page.locator('#route-mode').selectOption('foot');
    assert.ok(await page.locator('#route-result').isHidden());
    await page.locator('#route-search').click();
    await page.locator('#route-result').waitFor({ state: 'visible' });
    assert.match(await page.locator('#route-summary').innerText(), /徒歩/);
    assert.deepEqual(await page.evaluate(() => window.fixtureQueries.map(item => item.mode)), ['car', 'foot']);
    assert.ok(tileRequests.length > 0);
    assert.deepEqual(unexpected, []);
    assert.deepEqual(errors, []);
    assert.deepEqual(await page.evaluate(() => window.fixtureCsp), []);
    console.log('Edge: 同梱Leaflet・クリック・車/徒歩・経路線・事前生成への範囲引き渡しを確認。外部通信とCSP違反は0件。');
  } finally { await browser.close(); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
