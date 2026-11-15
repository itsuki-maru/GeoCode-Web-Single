import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { copyFrontendVendorAssets } from '../scripts/copy-frontend-vendor-assets.mjs';

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = resolve(workspace, 'target');
const packageFiles = resolve(workspace, 'src_frontend/frontend/node_modules');

async function fixture() {
  await mkdir(target, { recursive: true });
  const root = await mkdtemp(resolve(target, 'frontend-vendor-test-'));
  const output = resolve(root, 'owned output 日本語');
  const destination = resolve(output, '.build/frontend');
  await mkdir(destination, { recursive: true });
  await writeFile(resolve(output, '.geocode-frontend-output.json'), JSON.stringify({
    kind: 'geocode-web-single-frontend-output', workspace,
  }));
  return { root, output, destination };
}

async function cleanup(root) {
  assert.ok(resolve(root).startsWith(target + sep));
  await rm(root, { recursive: true, force: true });
}

test('隔離先に必要なvendor12件を生成し、画像・CSS・Markdownを維持する', async () => {
  const { root, output, destination } = await fixture();
  try {
    const names = await copyFrontendVendorAssets({ outputRoot: output, destination });
    assert.equal(names.length, 12);
    assert.deepEqual((await readdir(destination)).sort(), [
      'leaflet.js', 'layers.png', 'layers-2x.png', 'marker-icon.png', 'marker-icon-2x.png',
      'marker-shadow.png', 'leaflet.markercluster.js', 'MarkerCluster.css',
      'MarkerCluster.Default.css', 'xss.min.js', 'leaflet.css', 'marked.min.js',
    ].sort());
    for (const [source, name] of [
      ['leaflet/dist/leaflet.js', 'leaflet.js'],
      ['leaflet/dist/images/marker-icon.png', 'marker-icon.png'],
      ['leaflet/dist/images/layers-2x.png', 'layers-2x.png'],
      ['leaflet.markercluster/dist/leaflet.markercluster.js', 'leaflet.markercluster.js'],
      ['xss/dist/xss.min.js', 'xss.min.js'],
    ]) {
      assert.deepEqual(await readFile(resolve(destination, name)), await readFile(resolve(packageFiles, source)));
    }
    const css = await readFile(resolve(destination, 'leaflet.css'), 'utf8');
    assert.match(css, /url\(\/assets\/marker-icon\.png\)/);
    assert.match(css, /url\(\/assets\/layers\.png\)/);
    assert.match(css, /url\(\/assets\/layers-2x\.png\)/);
    assert.doesNotMatch(css, /url\((?:['"])?images\//);
    const marked = await readFile(resolve(destination, 'marked.min.js'), 'utf8');
    const originalMarked = await readFile(resolve(packageFiles, 'marked/lib/marked.umd.js'), 'utf8');
    assert.ok(marked.length < originalMarked.length, 'Markdown bundle must be minified');
    const context = {};
    vm.runInNewContext(marked, context, { timeout: 5000 });
    assert.equal(context.marked.parse('# 地図\n\n**確認**'), '<h1>地図</h1>\n<p><strong>確認</strong></p>\n');
    const xss = { window: {} };
    vm.runInNewContext(await readFile(resolve(destination, 'xss.min.js'), 'utf8'), xss, { timeout: 5000 });
    const sanitized = xss.window.filterXSS('<script>alert(1)</script><b>保持</b>');
    assert.doesNotMatch(sanitized, /<script>/);
    assert.match(sanitized, /<b>保持<\/b>/);
  } finally { await cleanup(root); }
});

test('所有記録や出力境界が不正なら書かず、既存ファイルを保持する', async () => {
  const { root, output, destination } = await fixture();
  try {
    const protectedDirectory = resolve(root, 'protected');
    await mkdir(protectedDirectory);
    const sentinel = resolve(protectedDirectory, 'keep.txt');
    await writeFile(sentinel, '保持');
    await assert.rejects(copyFrontendVendorAssets({ outputRoot: output, destination: protectedDirectory }), /専用ディレクトリ/);
    assert.equal(await readFile(sentinel, 'utf8'), '保持');
    for (const owner of [resolve(workspace, '..'), null]) {
      await writeFile(resolve(output, '.geocode-frontend-output.json'), JSON.stringify({
        kind: 'geocode-web-single-frontend-output', workspace: owner,
      }));
      await assert.rejects(copyFrontendVendorAssets({ outputRoot: output, destination }), /所有記録/);
      assert.deepEqual(await readdir(destination), []);
    }
    await assert.rejects(copyFrontendVendorAssets({ outputRoot: target, destination }), /専用ディレクトリ/);
  } finally { await cleanup(root); }
});

test('出力ファイルのリンクを拒否しリンク先を変更しない', async context => {
  const { root, output, destination } = await fixture();
  try {
    const protectedFile = resolve(root, 'protected.js');
    await writeFile(protectedFile, '保持');
    try { await symlink(protectedFile, resolve(destination, 'leaflet.js'), 'file'); }
    catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { context.skip('この環境はファイルリンク作成を許可していません'); return; }
      throw error;
    }
    await assert.rejects(copyFrontendVendorAssets({ outputRoot: output, destination }), /出力ファイル/);
    assert.equal(await readFile(protectedFile, 'utf8'), '保持');
  } finally { await cleanup(root); }
});

test('既存のvendor通常ファイルも上書きせず保持する', async () => {
  const { root, output, destination } = await fixture();
  try {
    const sentinel = resolve(destination, 'leaflet.js');
    await writeFile(sentinel, '既存データ');
    await assert.rejects(copyFrontendVendorAssets({ outputRoot: output, destination }), /上書きしません/);
    assert.equal(await readFile(sentinel, 'utf8'), '既存データ');
    assert.deepEqual(await readdir(destination), ['leaflet.js']);
  } finally { await cleanup(root); }
});
