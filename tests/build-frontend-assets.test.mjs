import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = join(workspace, 'target');
const wrapper = join(workspace, 'scripts', 'build-frontend-assets.ps1');
const powershell = process.env.PWSH_PATH || 'pwsh';
const available = !spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.Major'], { encoding: 'utf8' }).error;

function fixture() {
  mkdirSync(target, { recursive: true });
  return mkdtempSync(join(target, 'frontend-build-test-'));
}
function cleanup(directory) {
  const actual = resolve(directory);
  assert.ok(actual.startsWith(resolve(target) + sep));
  rmSync(actual, { recursive: true, force: true });
}
function validate(output) {
  return spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-File', wrapper, '-OutputRoot', output, '-ValidateOnly'], {
    cwd: workspace, encoding: 'utf8', windowsHide: true,
  });
}
function marker(output, owner = workspace) {
  mkdirSync(output, { recursive: true });
  writeFileSync(join(output, '.geocode-frontend-output.json'), JSON.stringify({ kind: 'geocode-web-single-frontend-output', workspace: owner }));
}

test('隔離出力の事前確認はディレクトリや設定を作成しない', { skip: !available }, () => {
  const base = fixture();
  try {
    const output = join(base, '未作成 output');
    const result = validate(output);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(output), false);
  } finally { cleanup(base); }
});

test('実行中アプリ用dist・共通ソース・target全体・workspace外を拒否する', { skip: !available }, () => {
  for (const output of [join(workspace, 'dist'), join(workspace, 'src_frontend'), target, resolve(workspace, '../not-a-build-output')]) {
    const result = validate(output);
    assert.notEqual(result.status, 0, output);
  }
});

test('所有記録のない既存データを上書きしない', { skip: !available }, () => {
  const base = fixture();
  try {
    const sentinel = join(base, 'catalog.sqlite');
    writeFileSync(sentinel, '既存データ');
    const result = validate(base);
    assert.notEqual(result.status, 0);
    assert.equal(readFileSync(sentinel, 'utf8'), '既存データ');
    assert.equal(existsSync(join(base, '.geocode-frontend-output.json')), false);
  } finally { cleanup(base); }
});

test('所有記録はworkspaceと一致し、事前確認で既存成果物を消さない', { skip: !available }, () => {
  const base = fixture();
  try {
    const valid = join(base, 'valid');
    marker(valid);
    writeFileSync(join(valid, 'index.html'), '既存成果物');
    assert.equal(validate(valid).status, 0);
    assert.equal(readFileSync(join(valid, 'index.html'), 'utf8'), '既存成果物');
    const invalid = join(base, 'invalid');
    marker(invalid, resolve(workspace, '..'));
    assert.notEqual(validate(invalid).status, 0);
  } finally { cleanup(base); }
});

test('出力内のjunctionやsymlinkを辿らず、リンク先のデータを保持する', { skip: !available }, (context) => {
  const base = fixture();
  try {
    const output = join(base, 'output');
    marker(output);
    const protectedDirectory = join(base, 'protected');
    mkdirSync(protectedDirectory);
    writeFileSync(join(protectedDirectory, 'keep.txt'), '保持');
    try { symlinkSync(protectedDirectory, join(output, 'linked'), process.platform === 'win32' ? 'junction' : 'dir'); }
    catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { context.skip('この環境はリンク作成を許可していません'); return; }
      throw error;
    }
    assert.notEqual(validate(output).status, 0);
    assert.equal(readFileSync(join(protectedDirectory, 'keep.txt'), 'utf8'), '保持');
  } finally { cleanup(base); }
});
