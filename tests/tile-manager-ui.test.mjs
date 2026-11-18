import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const root = resolve(import.meta.dirname, '..');
const source = readFileSync(resolve(root, 'tile-manager/app.js'), 'utf8');
const sandbox = vm.createContext({ Intl, Date, Set, Map, Promise, console });
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
  assert.equal(ui.progressView({ ...job, progress: { completed: 150, total: 100 } }).percentage, 100);
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
    assert.equal(view.percentage, null);
  }
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
  for (const match of html.matchAll(/(?:src|href)="([^"]+)"/g)) assert.match(match[1], /^(?:app\.js|style\.css)$/);
  assert.doesNotMatch(html, /\son\w+\s*=|\sstyle\s*=/i);
  assert.doesNotMatch(source, /\.innerHTML\s*=|insertAdjacentHTML|\bfetch\s*\(|XMLHttpRequest|WebSocket/);
  assert.doesNotMatch(css, /@import|url\(\s*["']?https?:/i);
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  assert.equal(ids.length, new Set(ids).size, 'duplicate HTML ids');
  for (const match of source.matchAll(/\$\('([^']+)'\)/g)) assert.ok(ids.includes(match[1]), `missing UI element: ${match[1]}`);
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

test('対応不一致でも移設の確認画面を使え、確認した計画だけを適用する', { skip: !JSDOM }, async () => {
  const snapshot = { ...configuredSnapshot(), error: '別の本体DBに対応しています', owner_available: false, rebind: { binding_matches: false } };
  const plan = { payload: { previous: { path: 'C:/old.sqlite' }, target: { path: 'D:/new.sqlite' }, evidence: 'original_database', catalog_contents: { rows: { local_tile_datasets: 3, local_tile_jobs: 17 } } }, signature: 'signed' };
  let submitted;
  const { dom, $ } = browserFixture(snapshot, async (command, args) => {
    if (command === 'tile_manager_query' && args.action === 'rebind_plan') return plan;
    if (command === 'tile_manager_submit') { submitted = args; return { id: args.requestId, state: 'starting' }; }
    return {};
  });
  try {
    await waitFor(() => !$('rebind-panel').hidden, 'repair panel unavailable');
    assert.equal($('rebind-apply').disabled, true);
    $('rebind-source').value = 'C:/old.sqlite';
    $('rebind-plan').click(); await waitFor(() => !$('rebind-apply').disabled, 'verified plan not shown');
    assert.match($('rebind-diagnosis').textContent, /17件/);
    $('rebind-source').value = 'C:/changed.sqlite'; $('rebind-source').dispatchEvent(new dom.window.Event('input'));
    assert.equal($('rebind-apply').disabled, true);
    $('rebind-plan').click(); await waitFor(() => !$('rebind-apply').disabled, 'new plan unavailable');
    $('rebind-apply').click(); await waitFor(() => submitted, 'repair not submitted');
    assert.equal(submitted.action, 'rebind'); assert.equal(submitted.payload.kind, 'apply');
    assert.deepEqual(plain(submitted.payload.plan), plan);
    assert.equal($('rebind-apply').disabled, true);
  } finally { await new Promise(resolve => setTimeout(resolve, 10)); dom.window.close(); }
});

test('照合中に条件が変わった移設計画は適用できない', { skip: !JSDOM }, async () => {
  let release;
  const { dom, $ } = browserFixture(configuredSnapshot(), async (command, args) => {
    if (command === 'tile_manager_query' && args.action === 'rebind_plan') return new Promise(resolve => { release = resolve; });
    return {};
  });
  try {
    await waitFor(() => !$('workspace').hidden, 'workspace unavailable');
    $('show-rebind').click(); $('rebind-plan').click(); await waitFor(() => release, 'plan not requested');
    $('rebind-proof').value = 'D:/different.json'; $('rebind-proof').dispatchEvent(new dom.window.Event('input'));
    release({ payload: { previous: {}, target: {}, catalog_contents: { rows: {} } } });
    await waitFor(() => !$('rebind-plan').disabled, 'plan not finished');
    assert.equal($('rebind-apply').disabled, true);
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
  snapshot.owner_available = false;
  snapshot.jobs = [{ id: 'job-one', kind: 'import', state: 'running', created_at: '2026-11-15T00:00:00Z',
    progress: { stage: 'ImportPass2', completed: 70, total: 100, elapsed_seconds: 9 }, request: { name: '日本' } }];
  snapshot.requests = [{ id: 'request-one', action: 'import', state: 'running', job_id: 'job-one', log_path: 'C:/isolated/output.log' }];
  let cancelled = false, copied = '';
  const { dom, $ } = browserFixture(snapshot, async (command, args) => {
    if (command === 'tile_manager_query' && args.action === 'url') return { relative_url: '/local-tiles/a/b/{z}/{x}/{y}.png' };
    if (command === 'tile_manager_query' && args.action === 'log') return { text: '</pre><img src=x onerror=alert(1)>', path: 'C:/isolated/output.log', truncated: true };
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
    dom.window.document.querySelector('.job-details button.button').click();
    await waitFor(() => $('log-dialog-text').textContent.includes('<img'), 'log not displayed');
    assert.equal($('log-dialog').open, true);
    assert.equal(dom.window.document.querySelectorAll('img').length, 0);
    assert.match($('log-dialog-note').textContent, /末尾/);
    dom.window.document.querySelector('.job-heading-right .danger').click();
    await waitFor(() => cancelled, 'cancel not invoked');
  } finally { await new Promise(resolve => setTimeout(resolve, 10)); dom.window.close(); }
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
    assert.equal(dom.window.document.querySelector('.job-card progress').value, 0);
    assert.equal(dom.window.document.querySelector('.job-heading-right .danger'), null);
    assert.equal($('running-count').textContent, '0');
    assert.equal($('import-submit').disabled, false);
    assert.equal($('notice-text').textContent, error);
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
