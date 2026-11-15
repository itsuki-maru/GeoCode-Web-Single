// 共通フロントのvendor生成を、SQLite版の所有する隔離出力へ適用する。
import { lstat, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const project = resolve(workspace, 'src_frontend/frontend');
const markerName = '.geocode-frontend-output.json';
const files = [
  ['leaflet/dist/leaflet.js', 'leaflet.js'],
  ['leaflet/dist/images/layers.png', 'layers.png'],
  ['leaflet/dist/images/layers-2x.png', 'layers-2x.png'],
  ['leaflet/dist/images/marker-icon.png', 'marker-icon.png'],
  ['leaflet/dist/images/marker-icon-2x.png', 'marker-icon-2x.png'],
  ['leaflet/dist/images/marker-shadow.png', 'marker-shadow.png'],
  ['leaflet.markercluster/dist/leaflet.markercluster.js', 'leaflet.markercluster.js'],
  ['leaflet.markercluster/dist/MarkerCluster.css', 'MarkerCluster.css'],
  ['leaflet.markercluster/dist/MarkerCluster.Default.css', 'MarkerCluster.Default.css'],
  ['xss/dist/xss.min.js', 'xss.min.js'],
];
const destinations = [...files.map(([, name]) => name), 'leaflet.css', 'marked.min.js'];

function samePath(first, second) {
  return process.platform === 'win32' ? first.toLowerCase() === second.toLowerCase() : first === second;
}

function requireChild(parent, child) {
  const path = relative(parent, child);
  if (!path || path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)) {
    throw Error(`出力は所有する専用ディレクトリ配下に限定します: ${child}`);
  }
}

async function requireUnlinkedPath(path) {
  if (!samePath(path, workspace)) requireChild(workspace, path);
  let current = path;
  while (true) {
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw Error(`リンクされた出力は使用できません: ${current}`);
    if (current === path && !info.isDirectory()) throw Error(`出力はディレクトリである必要があります: ${path}`);
    if (samePath(current, workspace)) break;
    const parent = dirname(current);
    if (samePath(parent, current)) throw Error('出力の親ディレクトリを確認できません。');
    current = parent;
  }
}

async function requireSafeDestinations(destination) {
  for (const name of destinations) {
    try {
      const path = resolve(destination, name);
      await lstat(path);
      throw Error(`既存のvendor出力ファイルは上書きしません: ${path}`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

async function validateOutput(outputRoot, destination) {
  requireChild(resolve(workspace, 'target'), outputRoot);
  requireChild(outputRoot, destination);
  await requireUnlinkedPath(outputRoot);
  await requireUnlinkedPath(destination);
  const markerPath = resolve(outputRoot, markerName);
  const markerInfo = await lstat(markerPath);
  if (!markerInfo.isFile() || markerInfo.isSymbolicLink()) throw Error('出力先の所有記録が不正です。');
  const marker = JSON.parse(await readFile(markerPath, 'utf8'));
  const expected = process.platform === 'win32' ? workspace.toLowerCase() : workspace;
  const owner = typeof marker.workspace === 'string' && isAbsolute(marker.workspace)
    ? resolve(marker.workspace) : '';
  if (marker.kind !== 'geocode-web-single-frontend-output' ||
      (process.platform === 'win32' ? owner.toLowerCase() : owner) !== expected) {
    throw Error('出力先の所有記録がこのworkspaceと一致しません。');
  }
  await requireSafeDestinations(destination);
}

export async function copyFrontendVendorAssets({ outputRoot, destination }) {
  if (!outputRoot || !destination) throw Error('--output-rootと--destinationが必要です。');
  outputRoot = resolve(outputRoot);
  destination = resolve(destination);
  await validateOutput(outputRoot, destination);
  const generated = new Map(await Promise.all(files.map(async ([source, name]) => [
    name, await readFile(resolve(project, 'node_modules', source)),
  ])));
  const css = await readFile(resolve(project, 'node_modules/leaflet/dist/leaflet.css'), 'utf8');
  const rewritten = css.replace(/url\((['"]?)images\/([^)'"\s]+)\1\)/g, 'url(/assets/$2)');
  if (rewritten === css) throw Error('Leafletの画像URLを変換できません。');
  generated.set('leaflet.css', rewritten);
  const require = createRequire(resolve(project, 'package.json'));
  const { transformWithEsbuild } = await import(pathToFileURL(require.resolve('vite')).href);
  const markedSource = await readFile(resolve(project, 'node_modules/marked/lib/marked.umd.js'), 'utf8');
  const marked = await transformWithEsbuild(markedSource, 'marked.umd.js', {
    legalComments: 'inline', minify: true, target: 'es2020',
  });
  generated.set('marked.min.js', marked.code);
  // 生成前の検査から出力構成が変わっていないことも確認する。
  await validateOutput(outputRoot, destination);
  // 検査後に同名ファイルが作られた場合も、リンク先や既存内容を上書きしない。
  for (const [name, bytes] of generated) await writeFile(resolve(destination, name), bytes, { flag: 'wx' });
  return [...generated.keys()];
}

async function main(args) {
  if (args.length !== 4 || args[0] !== '--output-root' || args[2] !== '--destination') {
    throw Error('使い方: node scripts/copy-frontend-vendor-assets.mjs --output-root PATH --destination PATH');
  }
  const copied = await copyFrontendVendorAssets({ outputRoot: args[1], destination: args[3] });
  console.log(`隔離出力へvendor資材を生成しました: ${copied.length} files`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => {
    console.error(`vendor資材生成失敗: ${error.message}`);
    process.exitCode = 1;
  });
}
