import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const root = resolve(import.meta.dirname, '..');
const source = readFileSync(resolve(root, 'tile-manager/app.js'), 'utf8');
const pathSource = readFileSync(resolve(root, 'tile-manager/paths.js'), 'utf8');
const routeSource = readFileSync(resolve(root, 'tile-manager/routes.js'), 'utf8');
const sandbox = vm.createContext({ Intl, Date, Set, Map, Promise, console });
vm.runInContext(pathSource, sandbox, { filename: 'tile-manager/paths.js' });
vm.runInContext(source, sandbox, { filename: 'tile-manager/app.js' });
const ui = sandbox.GeoCodeTileManager;
const plain = value => JSON.parse(JSON.stringify(value));
let JSDOM;
try { ({ JSDOM } = createRequire(resolve(root, 'src_frontend/frontend/package.json'))('jsdom')); } catch { /* Node-only checks remain available without frontend dependencies. */ }

test('名称付き取り込みは標高資料がある場合だけ等高線・標高基準を指定する', () => {
  const basic = ui.importPayload({ name: ' 全国 ', input_path: ' C:/map.osm.pbf ', contour_data: true, elevation_datum_policy: 'allow-jgd2000-2011' });
  assert.deepEqual(plain(basic), { name: '全国', input_path: 'C:/map.osm.pbf', features: 'standard-v2', missing_nodes: 'error', invalid_areas: 'skip-feature', contour_data: 'off' });
  const terrain = ui.importPayload({ name: '地形', input_path: 'C:/map.pbf', features: 'standard-v2', elevation_input: ' C:/dem ', landmask_input: 'C:/land.shp', contour_data: true, elevation_datum_policy: 'allow-jgd2000-2011' });
  assert.equal(terrain.contour_data, 'on');
  assert.equal(terrain.elevation_input, 'C:/dem');
  assert.equal(terrain.elevation_datum_policy, 'allow-jgd2000-2011');
  assert.throws(() => ui.importPayload({ name: '  ', input_path: 'C:/map.pbf' }), /地図の名前/);
});

test('道路形式には標準地図専用の資料・オプションを送らない', () => {
  const roads = ui.importPayload({ name: '道路', input_path: 'C:/map.pbf', features: 'roads-v1', elevation_input: 'C:/dem', landmask_input: 'C:/land.shp', contour_data: true, invalid_areas: 'skip-feature' });
  assert.deepEqual(plain(roads), { name: '道路', input_path: 'C:/map.pbf', features: 'roads-v1', missing_nodes: 'error' });
  const oldStandard = ui.importPayload({ name: '旧形式', input_path: 'C:/map.pbf', features: 'standard-v1', contour_data: true });
  assert.equal('contour_data' in oldStandard, false);
});

test('標準地図では既定で面を除外し、明示した停止設定は保持する', () => {
  for (const features of ['standard-v1', 'standard-v2']) {
    const values = { name: '地域地図', input_path: 'C:/map.pbf', features };
    assert.equal(ui.importPayload(values).invalid_areas, 'skip-feature');
    assert.equal(ui.importPayload({ ...values, invalid_areas: 'error' }).invalid_areas, 'error');
  }
});

const plan = { dataset_id: 'dataset', render_id: 'profile', west: '139.73', south: '35.65', east: '139.80', north: '35.71', min_zoom: '12', max_zoom: '15', max_tiles: '10000' };
test('事前生成は西南東北・整数ズーム・受付上限を正しい型で送る', () => {
  assert.deepEqual(plain(ui.precomputePayload(plan)), { dataset_id: 'dataset', render_id: 'profile', bbox: [139.73, 35.65, 139.8, 35.71], min_zoom: 12, max_zoom: 15, max_tiles: 10000 });
  const defaultProfile = ui.precomputePayload({ ...plan, render_id: '' });
  assert.equal('render_id' in defaultProfile, false);
  assert.equal(ui.precomputePayload({ ...plan, min_zoom: '0', max_zoom: '0' }).min_zoom, 0);
});

test('範囲・空欄・非数値・不正ズーム・巨大な受付上限を計画前に拒否する', () => {
  for (const patch of [
    { dataset_id: '' }, { west: '' }, { north: 'NaN' }, { south: '-86' }, { east: '181' }, { west: '150' },
    { south: '40' }, { min_zoom: '' }, { max_zoom: '' }, { min_zoom: '15.5' }, { max_zoom: '23' },
    { min_zoom: '16' }, { max_tiles: '0' }, { max_tiles: '3.5' }, { max_tiles: '9007199254740992' },
  ]) assert.throws(() => ui.precomputePayload({ ...plan, ...patch }), undefined, JSON.stringify(patch));
});

test('PBFの段階内件数を全体パーセントに見せない', () => {
  const view = ui.progressView({ kind: 'import', state: 'running', progress: { stage: 'ImportPass2', completed: 700, total: 1000, elapsed_seconds: 31 }, created_at: '2026-11-15T00:00:00Z' });
  assert.equal(view.percentage, null);
  assert.equal(view.completed, 700);
  assert.equal(view.total, 1000);
  assert.match(view.stage, /第2段階/);
  assert.equal(view.elapsed, 31);
  assert.equal(view.active, true);
});

test('事前生成だけ既知の全枚数から割合を計算し、取消待ちを実行中として扱う', () => {
  const job = { kind: 'precompute', state: 'cancelling', created_at: '2026-11-15T00:00:00Z', progress: { completed: 40, total: 100 } };
  const view = ui.progressView(job, Date.parse('2026-11-15T00:01:30Z'));
  assert.equal(view.percentage, 40);
  assert.equal(view.active, true);
  assert.match(view.stage, /実処理の終了/);
  assert.equal(view.elapsed, 90);
  assert.equal(ui.progressView({ ...job, progress: { completed: 150, total: 100 } }).percentage, 99);
  assert.equal(ui.progressView({ ...job, progress: { completed: 0, total: 0 } }).percentage, null);
  const done = ui.progressView({ ...job, state: 'succeeded', updated_at: '2026-11-15T00:02:00Z' }, Date.parse('2026-11-15T10:00:00Z'));
  assert.equal(done.elapsed, 120);
  assert.equal(done.active, false);
});

test('終端状態では最後の工程が保存されていても処理中のメッセージを表示しない', () => {
  const stages = {
    succeeded: '処理が完了しました', failed: '処理に失敗しました', cancelled: '処理を取り消しました',
    interrupted: '処理が中断しました', deadline_exceeded: '制限時間を超えたため処理を終了しました',
  };
  for (const [state, stage] of Object.entries(stages)) {
    const progress = { stage: 'BuildingGeometry', completed: 572504, elapsed_seconds: 31 };
    const view = ui.progressView({ kind: 'import', state, progress });
    assert.equal(view.stage, stage);
    assert.equal(view.active, false);
    assert.equal(view.completed, 572504, '最後に記録された件数は維持する');
    assert.equal(progress.stage, 'BuildingGeometry', '診断用の進捗履歴を書き換えない');
    assert.equal(view.percentage, state === 'succeeded' ? 100 : null);
  }
});

test('保存済みの全体進捗は再接続でも同じ値を示し、古い見積もりや取消時の残り時間は表示しない', () => {
  const now = Date.parse('2026-11-15T00:02:00Z');
  const job = { kind: 'route_build', state: 'running', progress: { stage: 'index', completed: 400, total: 900,
    sampled_at: new Date(now).toISOString(), estimate: { percent: 65.4, remaining_seconds: 90 } } };
  assert.equal(ui.progressView(job, now).percentage, 65.4);
  assert.equal(ui.progressView(job, now + 1000).remaining, 90);
  assert.equal(ui.progressView(job, now + 31000).remaining, null);
  assert.equal(ui.progressView(job, now + 31000).percentage, 65.4);
  assert.equal(ui.progressView({ ...job, state: 'cancelling' }, now).remaining, null);
  assert.equal(ui.progressView({ ...job, state: 'failed' }, now).remaining, null);
});

test('保存済み描画条件の名称・言語を表示し、不正JSONでも画面を停止しない', () => {
  assert.match(ui.profileLabel({ id: 'a'.repeat(64), info_json: JSON.stringify({ render_contract: { render_spec: { roads: true, buildings: false, labels: true, language: 'ja' } } }) }), /^道路・名称 ／ 日本語/);
  assert.match(ui.profileLabel({ id: 'b'.repeat(64), info_json: '{bad' }), /標準の描画条件/);
  assert.equal(ui.duration(3661), '1時間 1分');
});

test('受付応答が失われても同じ入力は同じ要求IDで再試行する', async () => {
  let serial = 0;
  const calls = [];
  const client = ui.createSubmissionClient(async (command, args) => {
    calls.push({ command, args });
    if (calls.length === 1) throw new Error('connection lost');
    return { id: args.requestId, state: 'starting' };
  }, () => `request-${++serial}`);
  await assert.rejects(client.submit('import', { name: '地図' }), /connection lost/);
  assert.equal(client.pending, false);
  await client.submit('import', { name: '地図' });
  assert.equal(calls[0].args.requestId, calls[1].args.requestId);
  await client.submit('import', { name: '地図' });
  assert.notEqual(calls[1].args.requestId, calls[2].args.requestId);
});

test('受付待ちの二重クリックは新しいworker要求を送信しない', async () => {
  let finish, calls = 0;
  const client = ui.createSubmissionClient(() => { calls += 1; return new Promise(resolve => { finish = resolve; }); }, () => 'one-request');
  const first = client.submit('precompute', { dataset_id: 'a' });
  assert.equal(client.pending, true);
  await assert.rejects(client.submit('precompute', { dataset_id: 'a' }), /受付を確認/);
  assert.equal(calls, 1);
  finish({ id: 'one-request', state: 'starting' });
  await first;
  assert.equal(client.pending, false);
});

test('専用画面は同梱資産だけを使い、HTML注入・HTTP API・inline handlerへ依存しない', () => {
  const html = readFileSync(resolve(root, 'tile-manager/index.html'), 'utf8');
  const css = readFileSync(resolve(root, 'tile-manager/style.css'), 'utf8');
  for (const match of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
    assert.ok(['app.js', 'paths.js', 'routes.js', 'style.css', '/assets/leaflet.js', '/assets/leaflet.css'].includes(match[1]));
  }
  assert.doesNotMatch(html, /\son\w+\s*=|\sstyle\s*=/i);
  assert.doesNotMatch(source + routeSource + pathSource, /\.innerHTML\s*=|insertAdjacentHTML|\bfetch\s*\(|XMLHttpRequest|WebSocket/);
  assert.doesNotMatch(css, /@import|url\(\s*["']?https?:/i);
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  assert.equal(ids.length, new Set(ids).size, 'duplicate HTML ids');
  for (const match of (source + routeSource).matchAll(/\$\('([^']+)'\)/g)) assert.ok(ids.includes(match[1]), `missing UI element: ${match[1]}`);
});

async function waitFor(check, message) {
  const deadline = Date.now() + 2000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(message);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

function browserFixture(snapshot, handler = async () => ({})) {
  const dom = new JSDOM(readFileSync(resolve(root, 'tile-manager/index.html'), 'utf8'), { url: 'http://tile-manager.localhost/index.html', runScripts: 'outside-only' });
  const calls = [];
  dom.window.__TAURI__ = { core: { invoke: async (command, args) => {
    calls.push({ command, args });
    if (command === 'tile_manager_snapshot') return snapshot;
    return handler(command, args);
  } } };
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  dom.window.HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
  dom.window.eval(pathSource);
  dom.window.eval(routeSource);
  dom.window.eval(source);
  return { dom, calls, $: id => dom.window.document.getElementById(id) };
}

function configuredSnapshot() {
  return { configured: true, config_path: 'C:/isolated/config.json', owner_available: true,
    config: { dataset_path: 'C:/isolated/datasets', cache_path: 'C:/isolated/png', work_path: 'C:/isolated/work' },
    datasets: [{ id: 'a'.repeat(64), name: '<img src=x onerror=alert(1)>の地図', created_at: '2026-11-15T00:00:00Z',
      info: { schema_version: 3, feature_count: 1234 }, database_path: 'C:/isolated/data.sqlite', current_profile_prepared: true,
      profiles: [{ id: 'b'.repeat(64), info_json: JSON.stringify({ render_contract: { render_spec: { roads: true, buildings: true, labels: true, language: 'ja' } } }) }] }],
    jobs: [], requests: [] };
}

const graphFixture = {
  id: 'graph-fixture-1', name: '関東', created_at: '2026-11-25T01:02:03Z',
  info: { source_sha256: '1'.repeat(64), bounds: { south: 35.6, west: 139.6, north: 35.7, east: 139.8 },
    node_count: 5, edge_count: 4, restriction_count: 1, excluded_restriction_count: 0, outside_restriction_count: 2,
    conditional_way_count: 3, conditional_node_count: 4, attribution: '© OpenStreetMap contributors' },
};
const start = { lat: 35.63, lon: 139.68 }, end = { lat: 35.67, lon: 139.75 };
const routeFixture = {
  geometry: [start, end], snapped_start: { lat: 35.6301, lon: 139.6801 }, snapped_end: end,
  distance_m: 1200, duration_s: 180,
};

function routeCoordinates({ dom, $ }) {
  for (const [place, point] of [['start', start], ['end', end]]) {
    for (const axis of ['lat', 'lon']) {
      const input = $('route-' + place + '-' + axis);
      input.value = point[axis];
      input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    }
  }
}

test('経路配信の保存は検索用の選択と独立し、ポーリング中も入力を保持する', { skip: !JSDOM }, async () => {
  const snapshot = { ...configuredSnapshot(), owner_available: false, routing: {
    datasets: [graphFixture, { ...graphFixture, id: 'other-generation', name: '日本' }], allowed_origins: 'https://existing.example',
  } };
  let saved;
  const { dom, $, calls } = browserFixture(snapshot, async (command, args) => {
    if (command !== 'tile_manager_save_route_http') throw Error('unexpected command');
    saved = plain(args);
    snapshot.routing.http = { enabled: true, dataset: args.dataset };
    snapshot.routing.allowed_origins += ',' + args.allowOrigin;
  });
  try {
    await waitFor(() => $('route-http-current').textContent.includes('無効'), 'settings missing');
    assert.equal($('route-http-enabled').checked, false);
    assert.equal($('route-http-allow').checked, true);
    assert.equal($('route-http-origin').value, 'http://127.0.0.1:3000');
    $('route-http-enabled').click();
    $('route-http-dataset').value = '日本';
    $('route-http-dataset').dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    const input = $('route-http-origin');
    input.value = 'http://127.0.0.1:3000/local-routing/car';
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    $('route-http-save').click();
    assert.equal(input.getAttribute('aria-invalid'), 'true');
    assert.equal($('route-http-origin-error').hidden, false);
    assert.equal(saved, undefined);
    input.value = 'http://localhost:4100';
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    snapshot.routing.datasets[1].id = 'new-generation';
    $('refresh-button').click();
    await waitFor(() => $('route-dataset').options[1].value === 'new-generation', 'refresh missing');
    assert.equal($('route-http-dataset').value, '日本');
    assert.equal(input.value, 'http://localhost:4100');
    assert.equal($('route-dataset').value, graphFixture.id);
    assert.equal(calls.filter(call => call.command === 'tile_manager_save_route_http').length, 0);
    $('route-http-save').click();
    await waitFor(() => $('route-http-status').textContent.includes('再起動'), 'save not acknowledged');
    assert.deepEqual(saved, { expected: { enabled: false, dataset: '' }, dataset: '日本', allowOrigin: 'http://localhost:4100' });
    $('refresh-button').click();
    await waitFor(() => $('route-http-current').textContent.includes('日本'), 'saved settings missing');
    assert.equal($('route-http-save').disabled, true);
    assert.match($('route-http-origins').textContent, /existing\.example.*localhost:4100/);
  } finally { dom.window.close(); }
});

test('経路配信は接続許可の追加を省略でき、完成済み道路網がなくても停止できる', { skip: !JSDOM }, async () => {
  const snapshot = { ...configuredSnapshot(), routing: { datasets: [graphFixture] } };
  const writes = [];
  const { dom, $ } = browserFixture(snapshot, async (_command, args) => {
    writes.push(plain(args));
    snapshot.routing.http = { enabled: args.dataset !== null, dataset: '関東' };
  });
  try {
    await waitFor(() => $('route-http-current').textContent.includes('無効'), 'settings missing');
    $('route-http-enabled').click();
    $('route-http-allow').click();
    assert.equal($('route-http-origin').disabled, true);
    $('route-http-save').click();
    await waitFor(() => writes.length === 1, 'save missing');
    assert.equal(writes[0].allowOrigin, null);
    snapshot.routing.datasets = [];
    $('refresh-button').click();
    await waitFor(() => $('route-http-current').textContent.includes('関東'), 'saved target missing');
    assert.equal($('route-http-save').disabled, true);
    assert.match($('route-http-dataset').selectedOptions[0].textContent, /道路網が見つかりません/);
    $('route-http-enabled').click();
    $('route-http-save').click();
    await waitFor(() => writes.length === 2, 'disable missing');
    assert.deepEqual(writes[1], { expected: { enabled: true, dataset: '関東' }, dataset: null, allowOrigin: null });
  } finally { dom.window.close(); }
});

test('未作成時の道路網構築と処理状況からの取消', { skip: !JSDOM }, async () => {
  const snapshot = configuredSnapshot();
  let submitted, cancel;
  const { dom, $ } = browserFixture(snapshot, async (command, args) => {
    if (command === 'tile_manager_submit') {
      submitted = args;
      snapshot.jobs = [{ id: args.requestId, kind: 'route_build', request: args.payload, state: 'running',
        progress: { stage: 'ways', completed: 10 } }];
      snapshot.owner_available = false;
      return { id: args.requestId, state: 'running' };
    }
    if (args.action === 'cancel') cancel = args.payload;
    return {};
  });
  try {
    await waitFor(() => !$('workspace').hidden, 'workspace unavailable');
    dom.window.document.querySelector('[data-view="routes"]').click();
    assert.ok($('route-build-panel').open);
    assert.ok($('route-workspace').hidden);
    $('route-name').value = ' 関東 ';
    $('route-pbf').value = 'C:/map.osm.pbf';
    $('route-build').click();
    await waitFor(() => $('activity-list').childElementCount, 'build not in activity');
    assert.equal(submitted.action, 'route_build');
    assert.deepEqual(plain(submitted.payload), { name: '関東', input_path: 'C:/map.osm.pbf' });
    assert.equal($('view-activity').hidden, false);
    assert.equal($('history-list').childElementCount, 0);
    assert.match($('activity-list').textContent, /道路網の作成 ／ 関東/);
    assert.match($('activity-list').textContent, /通行できる道路を読み取っています/);
    dom.window.document.querySelector('.job-heading-right .danger').click();
    await waitFor(() => cancel, 'route build not cancelled');
    assert.deepEqual(plain(cancel), { job: submitted.requestId });
  } finally { await new Promise(resolve => setTimeout(resolve, 10)); dom.window.close(); }
});

test('Leafletの地点指定・経路線・ローカル背景と未生成範囲の引き渡し', { skip: !JSDOM }, async () => {
  const snapshot = { ...configuredSnapshot(), routing: { datasets: [graphFixture] } };
  const tile = snapshot.datasets[0];
  tile.info.source_sha256 = graphFixture.info.source_sha256;
  tile.info.attribution = { text: graphFixture.info.attribution, additional: [['国土地理院（標高データを加工）', '']] };
  const { dom, $, calls } = browserFixture(snapshot, async () => routeFixture);
  try {
    const container = $('route-map');
    Object.defineProperties(container, { clientWidth: { value: 600 }, clientHeight: { value: 400 } });
    dom.window.SVGSVGElement.prototype.createSVGRect = () => ({});
    const leaflet = createRequire(resolve(root, 'src_frontend/frontend/package.json')).resolve('leaflet/dist/leaflet.js');
    dom.window.eval(readFileSync(leaflet, 'utf8'));
    const L = dom.window.L;
    const factory = L.map;
    let map;
    L.map = (...args) => (map = factory(...args));
    await waitFor(() => !$('workspace').hidden, 'workspace unavailable');
    dom.window.document.querySelector('[data-view="routes"]').click();
    assert.ok(map);
    assert.equal($('route-background').value, tile.id + '/' + tile.profiles[0].id);
    assert.match($('route-attribution').textContent, /OpenStreetMap.*国土地理院/);
    for (const point of [start, end]) map.fire('click', { latlng: L.latLng(point.lat, point.lon) });
    assert.equal(Number($('route-start-lon').value), start.lon);
    assert.equal(Number($('route-end-lat').value), end.lat);
    $('route-search').click();
    await waitFor(() => !$('route-result').hidden, 'route not visible');
    assert.deepEqual(plain(calls.find(c => c.args?.action === 'route_search').args.payload.start), start);
    assert.ok(container.querySelectorAll('svg path').length >= 5, 'line and both kinds of point must be drawn');
    const image = container.querySelector('img.leaflet-tile');
    assert.match(image.getAttribute('src'), /^\/preview\/[a-f0-9]{64}\/[a-f0-9]{64}\/\d+\/\d+\/\d+\.png$/);
    image.dispatchEvent(new dom.window.Event('error'));
    assert.match($('route-map-status').textContent, /事前生成/);
    assert.equal($('route-to-precompute').hidden, false);
    const bounds = map.getBounds(), zoom = map.getZoom();
    $('route-to-precompute').click();
    assert.equal($('view-precompute').hidden, false);
    assert.equal($('precompute-dataset').value, tile.id);
    assert.equal($('precompute-profile').value, tile.profiles[0].id);
    assert.equal(Number($('bbox-west').value), bounds.getWest());
    assert.equal(Number($('bbox-north').value), bounds.getNorth());
    assert.equal(Number($('precompute-min-zoom').value), zoom);
    assert.equal(Number($('precompute-max-zoom').value), zoom);
    assert.equal($('plan-result').hidden, true);
    dom.window.document.querySelector('[data-view="routes"]').click();
    $('route-background').value = ''; $('route-background').dispatchEvent(new dom.window.Event('change'));
    assert.equal(container.querySelectorAll('img.leaflet-tile').length, 0);
    assert.equal($('route-result').hidden, false, 'search outcome survives removal of the background');
    assert.match($('route-map-status').textContent, /背景なし/);
    assert.doesNotMatch($('route-attribution').textContent, /国土地理院/);
  } finally { dom.window.close(); }
});

test('タイル・writerがなくても座標から車・徒歩を検索し、制限と世代変更を反映する', { skip: !JSDOM }, async () => {
  const snapshot = { ...configuredSnapshot(), datasets: [], owner_available: false, routing: { datasets: [graphFixture] } };
  const queries = [];
  let answer = () => routeFixture, release;
  const fixture = browserFixture(snapshot, async (command, args) => {
    if (args.action === 'route_search') { queries.push(args.payload); return await answer(); }
    return {};
  });
  const { dom, $ } = fixture;
  try {
    await waitFor(() => !$('workspace').hidden, 'workspace unavailable');
    dom.window.document.querySelector('[data-view="routes"]').click();
    assert.equal($('route-build-panel').open, false);
    assert.equal($('route-build').disabled, true);
    assert.match($('route-info').textContent, /OpenStreetMap/);
    assert.match($('route-info').textContent, /道路網にない規制2 件.*通行タグのある道路3 本.*通行タグのある地点4 点/);
    assert.ok($('route-info').textContent.includes(graphFixture.info.source_sha256));
    routeCoordinates(fixture);
    $('route-search').click();
    await waitFor(() => !$('route-result').hidden, 'coordinate route unavailable');
    const { search_id: carId, ...carQuery } = plain(queries[0]);
    assert.match(carId, /^[0-9a-f-]{36}$/);
    assert.deepEqual(carQuery, { dataset: graphFixture.id, mode: 'car', start, end });
    assert.match($('route-summary').textContent, /自動車.*1.2 km.*3分/);
    assert.match($('route-snaps').textContent, /35.630100, 139.680100/);
    $('route-swap').click();
    assert.ok($('route-result').hidden);
    $('route-mode').value = 'foot'; $('route-mode').dispatchEvent(new dom.window.Event('change'));
    $('route-search').click();
    await waitFor(() => !$('route-result').hidden, 'foot route unavailable');
    const { search_id: footId, ...footQuery } = plain(queries[1]);
    assert.notEqual(footId, carId);
    assert.deepEqual(footQuery, { dataset: graphFixture.id, mode: 'foot', start: end, end: start });
    for (const error of ['この地点付近に通行できる道路がありません。', 'この2地点を結ぶ経路がありません。']) {
      answer = () => { throw Error(error); };
      $('route-search').click();
      await waitFor(() => $('route-search-status').textContent === error, 'error not displayed');
      assert.ok($('route-result').hidden);
    }
    answer = () => new Promise(resolve => { release = resolve; });
    $('route-search').click();
    await waitFor(() => release, 'pending query missing');
    snapshot.routing.datasets = [{ ...graphFixture, id: 'graph-fixture-2' }];
    $('refresh-button').click();
    await waitFor(() => $('route-dataset').value === 'graph-fixture-2', 'new graph missing');
    assert.deepEqual(fixture.calls.filter(call => call.args?.action === 'route_search_cancel')
      .map(call => call.args.payload.search_id), [queries.at(-1).search_id]);
    release(routeFixture);
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.ok($('route-result').hidden, 'superseded result must be discarded');
    assert.equal($('route-search').disabled, false);
  } finally { dom.window.close(); }
});

function storagePaths(database = 'C:/data/geocode-web.sqlite', tiles = 'C:/data/tiles') {
  return {database, catalog:tiles + '/catalog.sqlite', datasets:tiles + '/datasets', cache:tiles + '/png', work:tiles + '/work'};
}
async function openStorage(fixture) {
  await waitFor(() => !fixture.$('workspace').hidden, '管理画面の読込待ち');
  fixture.dom.window.document.querySelector('#navigation [data-view="storage"]').click();
  await waitFor(() => fixture.$('storage-database').value !== '', '保存先の読込待ち');
}
function typeStorage(fixture, id, value) {
  const input = fixture.$('storage-' + id);
  input.value = value;
  input.dispatchEvent(new fixture.dom.window.Event('input'));
}
test('データの保存先は元のDBが見つからなくても使え、本体DBだけを一度の操作で切り替える', { skip: !JSDOM }, async () => {
  const snapshot = {...configuredSnapshot(), error:'本体DBが見つかりません', owner_available:false};
  const picked = String.raw`\\?\E:\業務用\別の本体.sqlite`;
  let current = storagePaths(), expected = '設定1';
  const requests = [];
  const fixture = browserFixture(snapshot, async (command, {request} = {}) => {
    if (command === 'tile_manager_pick_path') return picked;
    if (command !== 'tile_manager_storage') return {};
    if (request.action === 'current') return {current, expected};
    requests.push(plain(request));
    current = {...current, database:picked};
    expected = '設定2'; delete snapshot.error; snapshot.owner_available = true;
    return {state:'succeeded', current, warnings:['作業フォルダーは未接続です。']};
  });
  const {dom, $} = fixture;
  try {
    await waitFor(() => !$('open-storage').hidden, '保存先への案内待ち');
    $('open-storage').click();
    await waitFor(() => !$('storage-apply').disabled, '保存先の読込待ち');
    assert.equal($('storage-database').value, current.database);
    assert.equal($('storage-tiles').value, 'C:/data/tiles');
    await pickPath(dom, 'storage-database');
    assert.equal($('storage-database').value, picked.slice(4));
    assert.equal(requests.length, 0);
    $('storage-apply').click();
    await waitFor(() => $('storage-status').textContent.includes('保存先を更新しました'), '保存完了待ち');
    assert.deepEqual(requests, [{action:'apply', expected:'設定1', selection:{files:{}, database:picked}}]);
    assert.match($('storage-status').textContent, /作業フォルダーは未接続/);
    assert.equal($('connection-error').hidden, true);
    assert.equal($('storage-database').value, picked.slice(4));
  } finally { dom.window.close(); }
});
test('tiles フォルダーの選び直しで保存先をまとめて切り替え、個別指定した項目を優先する', {skip:!JSDOM}, async () => {
  const root = 'E:/SD カード/tiles', cache = 'F:/保存したPNG';
  let current = storagePaths();
  const applied = [];
  const fixture = browserFixture(configuredSnapshot(), async (command, {request} = {}) => {
    if (command === 'tile_manager_pick_path') return root;
    if (command !== 'tile_manager_storage') return {};
    if (request.action === 'current') return {current, expected:'設定'};
    applied.push(plain(request));
    current = {...storagePaths(current.database, root), cache};
    return {state:'succeeded', current};
  });
  const {dom, $} = fixture;
  try {
    await openStorage(fixture);
    typeStorage(fixture, 'cache', cache);
    await pickPath(dom, 'storage-tiles');
    assert.equal($('storage-catalog').value, root + '/catalog.sqlite');
    assert.equal($('storage-datasets').value, root + '/datasets');
    assert.equal($('storage-cache').value, cache);
    $('storage-apply').click();
    await waitFor(() => $('storage-status').textContent.includes('更新しました'), '保存完了待ち');
    assert.deepEqual(applied, [{action:'apply', selection:{tiles:root, cache, files:{}}, expected:'設定'}]);
    assert.equal($('storage-tiles').value, '');
    assert.equal($('storage-cache').value, cache);
  } finally { dom.window.close(); }
});
test('完成DBが別の場所にあるときは地図名とエラーを表示し、新しいファイルを選んで再適用できる', {skip:!JSDOM}, async () => {
  const current = storagePaths(), target = storagePaths(current.database, 'D:/new');
  const picked = 'E:/個別/data.sqlite', applied = [];
  const fixture = browserFixture(configuredSnapshot(), async (command, {request} = {}) => {
    if (command === 'tile_manager_pick_path') return picked;
    if (command !== 'tile_manager_storage') return {};
    if (request.action === 'current') return {current,expected:'設定'};
    applied.push(plain(request));
    if (applied.length === 1) return {state:'needs_files',expected:'設定',current,target,
      maps:[{id:'one', name:'テスト地図', path:'D:/missing.sqlite', error:'完成DBがありません'}]};
    return {state:'succeeded',current:target};
  });
  const {dom, $} = fixture;
  try {
    await openStorage(fixture); typeStorage(fixture,'tiles','D:/new');
    $('storage-apply').click();
    await waitFor(() => $('storage-files').querySelector('button'), '地図の個別指定待ち');
    assert.match($('storage-files').textContent, /テスト地図/);
    assert.match($('storage-status').textContent, /1件/);
    $('storage-files').querySelector('button').click();
    await waitFor(() => $('storage-map-one').value === picked, '地図の選択待ち');
    $('storage-apply').click();
    await waitFor(() => $('storage-status').textContent.includes('更新しました'), '再適用待ち');
    assert.deepEqual(applied[1],{action:'apply',expected:'設定',selection:{tiles:'D:/new',files:{one:picked}}});
  } finally { dom.window.close(); }
});
test('個別地図の照会中に別のカタログを選んだ場合、古い照会結果は使用しない', {skip:!JSDOM}, async () => {
  let respond;
  const fixture = browserFixture(configuredSnapshot(), async (command, {request} = {}) => {
    if (command !== 'tile_manager_storage') return {};
    if (request.action === 'current') return {current:storagePaths(),expected:'設定'};
    return new Promise(resolve => { respond = resolve; });
  });
  const {dom,$} = fixture;
  try {
    await openStorage(fixture);
    $('storage-show-files').click();
    await waitFor(() => respond, '照会の開始待ち');
    typeStorage(fixture,'catalog','D:/他のカタログ.sqlite');
    respond({maps:[{id:'old',name:'古い地図',path:'C:/old.sqlite'}]});
    await waitFor(() => !$('storage-apply').disabled, '照会の完了待ち');
    assert.equal($('storage-files').textContent,'');
    assert.equal($('storage-catalog').value,'D:/他のカタログ.sqlite');
  } finally { dom.window.close(); }
});
test('保存中断時は再開操作を表示し、旧設定でカタログが未作成の場合は明示操作で作成する', {skip:!JSDOM}, async () => {
  const snapshot = {...configuredSnapshot(),error:'中断',relocation_pending:true};
  let fresh = true;
  const actions = [];
  const fixture = browserFixture(snapshot, async (command,{request}={}) => {
    if (command !== 'tile_manager_storage') return {};
    if (request.action === 'current') return {current:storagePaths(),expected:snapshot.relocation_pending ? null : '旧設定',
      pending:snapshot.relocation_pending,can_initialize_catalog:fresh,catalog_missing:fresh};
    actions.push(plain(request));
    if (request.action === 'recover') { snapshot.relocation_pending = false; delete snapshot.error; }
    if (request.action === 'initialize_catalog') fresh = false;
    return {state:'succeeded'};
  });
  const {dom,$} = fixture;
  try {
    await openStorage(fixture);
    assert.equal($('storage-recover').hidden,false);
    assert.equal($('storage-apply').disabled,true);
    $('storage-recover').click();
    await waitFor(() => !$('storage-init').hidden && !$('storage-initialize').disabled, '初期設定の読込待ち');
    assert.deepEqual(actions,[{action:'recover'}]);
    $('storage-initialize').click();
    await waitFor(() => $('storage-status').textContent.includes('作成しました'), '作成完了待ち');
    assert.deepEqual(actions[1],{action:'initialize_catalog',expected:'旧設定'});
    assert.equal($('storage-init').hidden,true);
  } finally { dom.window.close(); }
});
test('ドライブの再接続後に更新すると、入力中の保存先を保持して未接続の案内を消す', { skip: !JSDOM }, async () => {
  let missing = true;
  const fixture = browserFixture(configuredSnapshot(), async (command, { request } = {}) => {
    if (command === 'tile_manager_storage' && request.action === 'current') {
      return { current: storagePaths(), expected: '同じ設定', catalog_missing: missing };
    }
    return {};
  });
  const { dom, $ } = fixture;
  try {
    await openStorage(fixture);
    typeStorage(fixture, 'database', 'D:/選択中.sqlite');
    $('refresh-button').click();
    await waitFor(() => $('storage-status').textContent.includes('ドライブを接続'), '未接続の案内待ち');
    missing = false;
    $('refresh-button').click();
    await waitFor(() => !$('storage-status').textContent, '再接続の読込待ち');
    assert.equal($('storage-database').value, 'D:/選択中.sqlite');
  } finally { dom.window.close(); }
});

test('設定が他の操作で変更された場合は新しい保存先を読み込み直してから再試行できる', { skip: !JSDOM }, async () => {
  let current = storagePaths(), expected = '旧';
  const requests = [];
  const fixture = browserFixture(configuredSnapshot(), async (command, { request } = {}) => {
    if (command !== 'tile_manager_storage') return {};
    if (request.action === 'current') return { current, expected };
    requests.push(plain(request));
    if (expected === '旧') {
      expected = '新';
      current = storagePaths('F:/変更済み.sqlite');
      throw Error('別の操作で変更されました。');
    }
    return { state: 'succeeded', current };
  });
  const { dom, $ } = fixture;
  try {
    await openStorage(fixture);
    typeStorage(fixture, 'database', 'D:/選択.sqlite');
    $('storage-apply').click();
    await waitFor(() => $('storage-status').textContent.includes('別の操作'), 'エラー表示待ち');
    assert.equal($('storage-database').value, current.database);
    typeStorage(fixture, 'database', 'E:/再選択.sqlite');
    $('storage-apply').click();
    await waitFor(() => $('storage-status').textContent.includes('更新しました'), '再試行待ち');
    assert.equal(requests[1].expected, '新');
  } finally { dom.window.close(); }
});

test('初期フォームから除外設定を送信し、停止の明示選択と道路形式も尊重する', { skip: !JSDOM }, async () => {
  for (const values of [
    { features: 'standard-v2', policy: null, expected: 'skip-feature' },
    { features: 'standard-v1', policy: null, expected: 'skip-feature' },
    { features: 'standard-v2', policy: 'error', expected: 'error' },
    { features: 'roads-v1', policy: null, expected: undefined },
  ]) {
    let submitted;
    const { dom, $ } = browserFixture(configuredSnapshot(), async (command, args) => {
      if (command === 'tile_manager_submit') {
        submitted = args;
        return { id: args.requestId, state: 'starting' };
      }
      return {};
    });
    try {
      await waitFor(() => !$('workspace').hidden, 'workspace not initialized');
      assert.equal($('import-invalid').value, 'skip-feature');
      $('import-pbf').value = 'C:/isolated/map.osm.pbf';
      $('import-features').value = values.features;
      $('import-features').dispatchEvent(new dom.window.Event('change', { bubbles: true }));
      if (values.policy) $('import-invalid').value = values.policy;
      $('import-form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
      await waitFor(() => submitted, 'import not submitted');
      assert.equal(submitted.action, 'import');
      assert.equal(submitted.payload.features, values.features);
      assert.equal(submitted.payload.invalid_areas, values.expected);
      assert.equal(submitted.payload.missing_nodes, 'error');
    } finally { await new Promise(resolve => setTimeout(resolve, 10)); dom.window.close(); }
  }
});

test('DOM上でも計画を確認した条件だけで事前生成を開始する', { skip: !JSDOM }, async () => {
  const snapshot = configuredSnapshot();
  let submitted;
  const fixture = browserFixture(snapshot, async (command, args) => {
    if (command === 'tile_manager_query' && args.action === 'plan') return { allowed: true, total_tiles: 42, max_tiles: 10000, render_id: 'b'.repeat(64), zooms: { 12: 10, 13: 32 } };
    if (command === 'tile_manager_submit') { submitted = args; return { id: args.requestId, state: 'starting' }; }
    return {};
  });
  const { dom, $ } = fixture;
  try {
    await waitFor(() => !$('workspace').hidden, 'workspace not initialized');
    dom.window.document.querySelector('[data-view="precompute"]').click();
    $('precompute-form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    await waitFor(() => !$('plan-result').hidden, 'plan not displayed');
    assert.equal($('plan-count').textContent, '42');
    assert.equal($('precompute-run').disabled, false);
    $('bbox-west').value = '139.74';
    $('bbox-west').dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    assert.equal($('plan-result').hidden, true);
    assert.equal($('precompute-run').disabled, true);
    assert.equal(submitted, undefined);
    $('precompute-form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    await waitFor(() => !$('plan-result').hidden, 'changed plan not displayed');
    $('precompute-run').click();
    await waitFor(() => submitted, 'precompute not submitted');
    assert.equal(submitted.action, 'precompute');
    assert.equal(submitted.payload.bbox[0], 139.74);
    assert.equal(submitted.payload.render_id, 'b'.repeat(64));
    await waitFor(() => !$('view-activity').hidden, 'activity not displayed after acceptance');
    assert.equal(dom.window.document.querySelectorAll('img').length, 0, 'dataset name injected HTML');
  } finally { await new Promise(resolve => setTimeout(resolve, 10)); dom.window.close(); }
});

test('実行中もURL照会・ログ・取消が使え、PBF全体の偽割合やHTMLを挿入しない', { skip: !JSDOM }, async () => {
  const snapshot = configuredSnapshot();
  const nativeLog = String.raw`\\?\C:\日本の地図\output.log`;
  const shownLog = String.raw`C:\日本の地図\output.log`;
  snapshot.owner_available = false;
  snapshot.jobs = [{ id: 'job-one', kind: 'import', state: 'running', created_at: '2026-11-15T00:00:00Z',
    progress: { stage: 'ImportPass2', completed: 70, total: 100, elapsed_seconds: 9 }, request: { name: '日本' } }];
  snapshot.requests = [{ id: 'request-one', action: 'import', state: 'running', job_id: 'job-one', log_path: nativeLog }];
  let cancelled = false, copied = '';
  const { dom, $ } = browserFixture(snapshot, async (command, args) => {
    if (command === 'tile_manager_query' && args.action === 'url') return { relative_url: '/local-tiles/a/b/{z}/{x}/{y}.png' };
    if (command === 'tile_manager_query' && args.action === 'log') {
      assert.deepEqual(plain(args.payload), { request_id: 'request-one' });
      return { text: 'ログ ' + nativeLog + '\n</pre><img src=x onerror=alert(1)>', path: nativeLog, truncated: true };
    }
    if (command === 'tile_manager_query' && args.action === 'cancel') { cancelled = true; return {}; }
    return {};
  });
  Object.defineProperty(dom.window.navigator, 'clipboard', { value: { writeText: async value => { copied = value; } } });
  try {
    await waitFor(() => !$('workspace').hidden, 'workspace not initialized');
    assert.equal($('import-submit').disabled, true);
    assert.equal($('plan-submit').disabled, false, 'read-only plan should remain available');
    const progress = dom.window.document.querySelector('.job-card progress');
    assert.equal(progress.hasAttribute('value'), false, 'PBF should not appear as 70% of all work');
    $('dataset-copy-url').click();
    await waitFor(() => copied, 'URL not copied');
    assert.equal(copied, '/local-tiles/a/b/{z}/{x}/{y}.png');
    const logButton = dom.window.document.querySelector('.job-log .text-button');
    assert.equal(dom.window.document.querySelector('.job-log .path-value').textContent, shownLog);
    logButton.click();
    await waitFor(() => copied === shownLog, 'log path not copied');
    dom.window.document.querySelector('.job-details button.button').click();
    await waitFor(() => $('log-dialog-text').textContent.includes('<img'), 'log not displayed');
    assert.equal($('log-dialog').open, true);
    assert.equal($('log-dialog-path').textContent, shownLog);
    assert.equal($('log-dialog-text').textContent.split('\n')[0], 'ログ ' + shownLog);
    assert.equal(snapshot.requests[0].log_path, nativeLog);
    assert.equal(dom.window.document.querySelectorAll('img').length, 0);
    assert.match($('log-dialog-note').textContent, /末尾/);
    dom.window.document.querySelector('.job-heading-right .danger').click();
    await waitFor(() => cancelled, 'cancel not invoked');
  } finally { await new Promise(resolve => setTimeout(resolve, 10)); dom.window.close(); }
});

test('設定・完成DB・履歴・経路の診断に通常表記を使い、受付データを保持する', { skip: !JSDOM }, async () => {
  const snapshot = configuredSnapshot();
  const original = String.raw`\\?\UNC\server\share\地図 資料\a.sqlite`;
  const shown = String.raw`\\server\share\地図 資料\a.sqlite`;
  snapshot.config_path = original;
  snapshot.config.dataset_path = original;
  snapshot.datasets[0].database_path = original;
  snapshot.datasets[0].error = '読込失敗: ' + original;
  snapshot.routing = { error: '読込失敗: ' + original, datasets: [] };
  snapshot.jobs = [{ id: 'job-one', kind: 'import', state: 'failed', request: { input_path: original },
    progress: { diagnostics: [{ level: 'Error', message: '未検出: ' + original }] }, error: '読込失敗: ' + original }];
  snapshot.requests = [{ id: 'receipt-one', action: 'register', state: 'succeeded', result: { database_path: original } }];
  const before = JSON.stringify(snapshot);
  const { dom, $ } = browserFixture(snapshot);
  try {
    await waitFor(() => !$('workspace').hidden, 'workspace unavailable');
    $('show-settings').click();
    assert.equal($('settings-values').querySelector('dd').textContent, shown);
    assert.equal($('setup-config-path').textContent, shown);
    assert.equal($('dataset-detail-path').textContent, shown);
    assert.equal($('dataset-detail-error').textContent, '読込失敗: ' + shown);
    assert.equal($('route-catalog-error').textContent, '読込失敗: ' + shown);
    const details = dom.window.document.querySelector('.job-details pre').textContent;
    assert.ok(details.includes('未検出: ' + shown));
    assert.ok(details.includes('読込失敗: ' + shown));
    assert.equal(JSON.parse(details.split('\n入力条件\n')[1]).input_path, shown);
    assert.equal(JSON.parse(dom.window.document.querySelector('.receipt-result').textContent).database_path, shown);
    assert.equal(JSON.stringify(snapshot), before);
  } finally { dom.window.close(); }
});

test('処理状況と履歴は受付とジョブを一度だけ数え、履歴を終了日時順に表示する', { skip: !JSDOM }, async () => {
  const snapshot = configuredSnapshot();
  const { dom, $ } = browserFixture(snapshot);
  const ids = list => [...$(list).querySelectorAll('[data-job-id]')].map(detail => detail.dataset.jobId);
  try {
    await waitFor(() => !$('workspace').hidden, 'workspace not initialized');
    assert.deepEqual([...$('navigation').querySelectorAll('[data-view]')].map(button => button.dataset.view),
      ['import', 'datasets', 'precompute', 'routes', 'activity', 'history', 'storage']);
    assert.equal($('open-storage').hidden, true);
    assert.equal($('activity-empty').hidden, false);
    assert.equal($('history-empty').hidden, false);
    $('activity-empty').querySelector('button').click();
    assert.equal($('navigation').querySelector('[aria-current="page"]').dataset.view, 'history');
    snapshot.jobs = [
      { id: 'active-job', kind: 'import', state: 'running', request: { request_id: 'active-receipt' } },
      { id: 'stopped', kind: 'precompute', state: 'cancelled', created_at: '2026-11-01', updated_at: '2026-11-22' },
      { id: 'finished', kind: 'import', state: 'succeeded', updated_at: '2026-11-20' },
    ];
    snapshot.requests = [
      { id: 'active-receipt', action: 'import', state: 'running' },
      { id: 'waiting', action: 'prepare', state: 'queued' },
      { id: 'new', action: 'register', state: 'starting' },
      { id: 'cancelling', action: 'route_build', state: 'cancelling' },
      { id: 'linked', action: 'import', job_id: 'finished', state: 'succeeded' },
      { id: 'orphan', action: 'import', job_id: 'outside-job-list', state: 'interrupted', updated_at: '2026-11-23' },
      { id: 'expired', action: 'prepare', state: 'deadline_exceeded', created_at: '2026-11-21' },
      { id: 'registered', action: 'register', state: 'succeeded', updated_at: '2026-11-19' },
    ];
    $('refresh-button').click();
    await waitFor(() => $('running-count').textContent === '4', 'wrong active count');
    assert.equal($('nav-job-count').textContent, '4');
    assert.equal($('completed-count').textContent, '2');
    assert.deepEqual(ids('activity-list'), ['active-job', 'waiting', 'new', 'cancelling']);
    assert.deepEqual(ids('history-list'), ['orphan', 'stopped', 'expired', 'finished', 'registered']);
    assert.equal($('activity-empty').hidden, true);
    assert.equal($('history-empty').hidden, true);
    assert.equal($('notice').hidden, true);
    assert.equal($('view-history').hidden, false);
  } finally { dom.window.close(); }
});

test('事前生成を履歴から再開すると処理状況が開き、終了時には履歴だけを更新する', { skip: !JSDOM }, async () => {
  const snapshot = configuredSnapshot();
  snapshot.jobs = [{ id: 'old-job', kind: 'precompute', state: 'interrupted' }];
  let submitted;
  const { dom, $ } = browserFixture(snapshot, async (command, args) => {
    if (command === 'tile_manager_submit') {
      submitted = args;
      const receipt = { id: args.requestId, action: args.action, state: 'starting' };
      snapshot.requests.push(receipt);
      return receipt;
    }
    return {};
  });
  try {
    await waitFor(() => !$('workspace').hidden, 'workspace not initialized');
    $('navigation').querySelector('[data-view="history"]').click();
    const resume = $('history-list').querySelector('[data-writer]');
    assert.equal(resume.textContent, '再開');
    resume.click();
    await waitFor(() => !$('view-activity').hidden && $('activity-list').childElementCount, 'resume not accepted');
    assert.equal(submitted.action, 'resume');
    assert.deepEqual(plain(submitted.payload), { job: 'old-job' });
    assert.equal($('running-count').textContent, '1');
    snapshot.jobs.unshift({ id: 'new-job', kind: 'precompute', state: 'succeeded', request: { request_id: submitted.requestId } });
    snapshot.requests[0].state = 'succeeded';
    $('refresh-button').click();
    await waitFor(() => !$('notice-history').hidden, 'missing completion link');
    assert.equal($('view-activity').hidden, false);
    assert.equal($('activity-list').childElementCount, 0);
    assert.equal($('history-list').childElementCount, 2);
    assert.equal($('completed-count').textContent, '1');
    $('notice-history').click();
    assert.equal($('view-history').hidden, false);
    $('dismiss-notice').click();
    $('refresh-button').click();
    await waitFor(() => !$('refresh-button').disabled, 'refresh still pending');
    assert.equal($('notice').hidden, true);
  } finally { dom.window.close(); }
});

test('取込ジョブが受付より先に完了しても、新しいデータセットを選択する', { skip: !JSDOM }, async () => {
  const snapshot = configuredSnapshot();
  snapshot.jobs = [{ id: 'import-job', kind: 'import', state: 'running' }];
  snapshot.requests = [{ id: 'receipt', job_id: 'import-job', action: 'import', state: 'running', result: { id: 'import-job' } }];
  const { dom, $ } = browserFixture(snapshot);
  try {
    await waitFor(() => !$('workspace').hidden, 'workspace not initialized');
    snapshot.jobs[0].state = 'succeeded';
    snapshot.jobs[0].dataset_id = 'new-dataset';
    snapshot.datasets.push({ ...snapshot.datasets[0], id: 'new-dataset', name: '追加した地図' });
    $('refresh-button').click();
    await waitFor(() => !$('notice-history').hidden, 'completion not shown');
    assert.equal($('dataset-detail-name').textContent, '追加した地図');
    assert.equal($('history-list').childElementCount, 1);
    assert.equal($('view-import').hidden, false);
  } finally { dom.window.close(); }
});

test('道路網の全体バーと工程の件数を分けて表示し、取消後には残り時間を消す', { skip: !JSDOM }, async () => {
  const snapshot = configuredSnapshot();
  snapshot.jobs = [{ id: 'route-progress', kind: 'route_build', state: 'running', progress: {
    stage: 'index', completed: 20000, total: 50000, elapsed_seconds: 3600,
    sampled_at: new Date().toISOString(), estimate: { percent: 76.8, remaining_seconds: 540 },
  } }];
  const { dom, $ } = browserFixture(snapshot);
  try {
    await waitFor(() => !$('workspace').hidden, 'workspace not initialized');
    $('navigation').querySelector('[data-view="activity"]').click();
    const bar = $('activity-list').querySelector('progress');
    assert.equal(bar.value, 76.8);
    assert.equal(bar.getAttribute('aria-valuetext'), '全体 約76%');
    assert.match($('activity-list').textContent, /20,000 \/ 50,000 道路区間/);
    assert.match($('activity-list').textContent, /残り 約7〜12分/);
    snapshot.jobs[0].state = 'cancelling';
    $('refresh-button').click();
    await waitFor(() => !$('activity-list').querySelector('.remaining-time'), 'ETA still visible');
    assert.match($('activity-list').textContent, /取消を要求/);
    snapshot.jobs[0].state = 'cancelled';
    $('refresh-button').click();
    await waitFor(() => $('history-list').childElementCount === 1, 'cancelled job not in history');
    assert.match($('history-list').textContent, /全体 約76%/);
    assert.equal($('history-list').querySelector('.remaining-time'), null);
  } finally { dom.window.close(); }
});

test('PBF取込の失敗を受け取った画面は工程の実行中表示を終了する', { skip: !JSDOM }, async () => {
  const snapshot = configuredSnapshot();
  snapshot.owner_available = false;
  snapshot.jobs = [{ id: 'failed-import', kind: 'import', state: 'running', created_at: '2026-11-15T00:00:00Z',
    progress: { stage: 'BuildingGeometry', completed: 572504, elapsed_seconds: 31 }, request: { name: '四国' } }];
  snapshot.requests = [{ id: 'failed-request', action: 'import', state: 'running', job_id: 'failed-import' }];
  const { dom, $ } = browserFixture(snapshot);
  const caption = () => dom.window.document.querySelector('.job-card .progress-caption span').textContent;
  try {
    await waitFor(() => !$('workspace').hidden, 'workspace not initialized');
    assert.equal(caption(), '地物と縮約形状を作成しています');
    assert.equal($('running-count').textContent, '1');
    const error = 'PBF取り込みに失敗しました: 面relation 572505の構築に失敗しました';
    snapshot.owner_available = true;
    snapshot.jobs[0] = { ...snapshot.jobs[0], state: 'failed', error, updated_at: '2026-11-15T00:00:32Z' };
    snapshot.requests[0] = { ...snapshot.requests[0], state: 'failed', error };
    $('refresh-button').click();
    await waitFor(() => caption() === '処理に失敗しました', 'failed import still appears to be running');
    assert.equal(dom.window.document.querySelector('.job-card .job-error').textContent, error);
    assert.equal($('activity-list').childElementCount, 0);
    assert.equal($('activity-empty').hidden, false);
    assert.equal($('history-list').childElementCount, 1);
    assert.equal($('history-list').querySelector('progress'), null);
    assert.equal(dom.window.document.querySelector('.job-heading-right .danger'), null);
    assert.equal($('running-count').textContent, '0');
    assert.equal($('import-submit').disabled, false);
    assert.equal($('notice-text').textContent, error);
    assert.equal($('view-import').hidden, false);
    assert.equal($('notice-history').hidden, false);
    $('notice-history').click();
    assert.equal($('view-history').hidden, false);
  } finally { await new Promise(resolve => setTimeout(resolve, 10)); dom.window.close(); }
});

test('初回設定は既存セットアップと同じ認証既定値を送り、パスワード確認を行う', { skip: !JSDOM }, async () => {
  let form;
  const { dom, $ } = browserFixture({ configured: false, config_path: 'C:/isolated/config.json' }, async (command, args) => {
    if (command === 'tile_manager_initialize') form = args.form;
    return {};
  });
  try {
    await waitFor(() => !$('setup-panel').hidden, 'setup not displayed');
    $('setup-password').value = 'correct-value-2026';
    $('setup-password-confirm').value = 'different-value';
    $('setup-form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(form, undefined);
    assert.match($('notice-text').textContent, /一致しません/);
    $('setup-password-confirm').value = 'correct-value-2026';
    $('setup-form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    await waitFor(() => form, 'setup not invoked');
    assert.equal(form.failed_account_lock, '15');
    assert.equal(form.next_challenge_minutes, '5');
    assert.equal(form.access_token_exp_minutes, '60');
    assert.equal(form.refresh_token_exp_minutes, '1440');
  } finally { await new Promise(resolve => setTimeout(resolve, 10)); dom.window.close(); }
});

async function pickPath(dom, inputId) {
  const button = dom.window.document.querySelector('[data-target="' + inputId + '"]');
  button.click();
  await waitFor(() => !button.disabled, 'file picker did not complete');
}

test('取り込みの選択欄は通常表記で表示し、PBF・陸域・標高の元のパスを送る', { skip: !JSDOM }, async () => {
  const pbf = String.raw`\\?\D:\地図 資料\高松.osm.pbf`;
  const landmask = String.raw`\\?\UNC\server\share\陸域.shp`;
  const elevation = String.raw`\\?\D:\標高\末尾空白 `;
  let submitted;
  const { dom, $ } = browserFixture(configuredSnapshot(), async (command, args) => {
    if (command === 'tile_manager_pick_path') return { pbf, landmask, elevation }[args.kind];
    if (command === 'tile_manager_submit') submitted = args;
    return {};
  });
  try {
    await waitFor(() => !$('workspace').hidden, 'workspace unavailable');
    await pickPath(dom, 'import-pbf');
    await pickPath(dom, 'import-landmask');
    await pickPath(dom, 'import-elevation');
    assert.equal($('import-pbf').value, String.raw`D:\地図 資料\高松.osm.pbf`);
    assert.equal($('import-landmask').value, String.raw`\\server\share\陸域.shp`);
    assert.equal($('import-elevation').value, elevation);
    $('import-submit').click();
    await waitFor(() => submitted, 'import was not submitted');
    assert.equal(submitted.payload.input_path, pbf);
    assert.equal(submitted.payload.landmask_input, landmask);
    assert.equal(submitted.payload.elevation_input, elevation);
  } finally { await new Promise(resolve => setTimeout(resolve, 10)); dom.window.close(); }
});

test('経路PBFは選択時の元パスを使い、貼り付け・手編集では新しい入力を使う', { skip: !JSDOM }, async () => {
  const original = String.raw`\\?\D:\高松.osm.pbf`;
  const pasted = String.raw`\\?\UNC\server\share\次の地図.osm.pbf`;
  const plainPasted = String.raw`\\server\share\次の地図.osm.pbf`;
  const submitted = [];
  const { dom, $ } = browserFixture(configuredSnapshot(), async (command, args) => {
    if (command === 'tile_manager_pick_path') return original;
    if (command === 'tile_manager_submit') submitted.push(args.payload.input_path);
    return {};
  });
  try {
    await waitFor(() => !$('workspace').hidden, 'workspace unavailable');
    const openRoutes = () => dom.window.document.querySelector('[data-view="routes"]').click();
    openRoutes();
    $('route-name').value = 'テスト';
    const input = $('route-pbf');
    await pickPath(dom, input.id);
    assert.equal(input.value, String.raw`D:\高松.osm.pbf`);
    async function build(expected) {
      const previous = submitted.length;
      $('route-build').click();
      await waitFor(() => submitted.length > previous && !$('route-build').disabled, 'route build did not complete');
      assert.equal(submitted[previous], expected);
      openRoutes();
    }
    await build(original);
    input.value = pasted;
    input.dispatchEvent(new dom.window.InputEvent('input', { bubbles: true, inputType: 'insertFromPaste' }));
    assert.equal(input.value, plainPasted);
    await build(pasted);
    input.value = plainPasted + '.tmp';
    input.dispatchEvent(new dom.window.Event('input'));
    input.value = plainPasted;
    input.dispatchEvent(new dom.window.Event('input'));
    await build(plainPasted);
  } finally { await new Promise(resolve => setTimeout(resolve, 10)); dom.window.close(); }
});
