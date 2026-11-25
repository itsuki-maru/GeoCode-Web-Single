import assert from 'node:assert/strict';
import { test } from 'node:test';
import '../tile-manager/paths.js';

const { displayPath, displayText, displayData } = globalThis.GeoCodeTilePaths;
const prefix = '\\\\?\\';
const file = 'C:\\地図データ\\高松 市\\経路.log';
const share = '\\\\保存先\\地図共有\\経路.log';
const extendedShare = prefix + 'UNC' + share.slice(1);

test('表示ではドライブとUNCの絶対パスだけを通常表記にする', () => {
  for (const path of [file, 'c:\\', 'D:\\地図\\', 'D:\\' + '地図\\'.repeat(150) + 'a.pbf']) {
    assert.equal(displayPath(prefix + path), path);
  }
  assert.equal(displayPath(extendedShare), share);
  assert.equal(displayPath(prefix + 'unc\\server\\share\\'), '\\\\server\\share\\');
  for (const value of [undefined, null, 4, '', file, share, '/tmp/file', 'relative.txt', 'http://localhost/?x=1']) {
    assert.equal(displayPath(value), value);
  }
});

test('通常表記で意味が変わり得るパスとデバイス名前空間は保持する', () => {
  for (const body of ['Volume{1234}\\a', 'GLOBALROOT\\Device\\Volume1\\a', 'C:relative',
    'UNC\\server', 'UNC\\\\share\\a', 'UNC\\.\\C$\\a', 'UNC\\localhost\\pipe\\worker',
    'UNC\\server\\MAILSLOT\\demo', 'C:\\A\\..\\B', 'C:\\.\\B',
    'C:\\dir.\\a', 'C:\\dir\\tail ', 'C:\\tmp\\a/b', 'C:\\a\\\\b', 'C:\\nul.txt',
    'C:\\Com¹.log', 'C:\\conout$', 'C:\\nul .log', 'C:\\file:stream', 'C:\\a?\u0000b']) {
    assert.equal(displayPath(prefix + body), prefix + body);
  }
  assert.equal(displayPath('\\\\.\\pipe\\local-tiles'), '\\\\.\\pipe\\local-tiles');
});

test('表示用の構造化データだけを整形し、元の操作と名前・URLは保持する', () => {
  const source = { input_path: prefix + file, name: prefix + file, url: 'https://test/?a=' + prefix + file,
    nested: [{ database: extendedShare, message: '失敗: ' + prefix + file, value: 2 }],
    backup: prefix + file, receipt: prefix + file };
  const shown = displayData(source);
  assert.deepEqual(shown, { input_path: file, name: prefix + file, url: source.url,
    nested: [{ database: share, message: '失敗: ' + file, value: 2 }], backup: file, receipt: file });
  assert.equal(source.input_path, prefix + file);
  assert.equal(source.nested[0].database, extendedShare);
});

test('診断・ログの改行を保ち、パスと引用・JSONエスケープされたパスを整形する', () => {
  const json = JSON.stringify({ input_path: prefix + file, error: 'ファイル: ' + extendedShare, name: prefix + file });
  const log = '参照: 「' + prefix + file + '」\r\n読込: ' + prefix + file + ': error\n' +
    '元: ' + prefix + file + ' -> ' + extendedShare + '\n"' + extendedShare + '"\n' + json;
  assert.equal(displayText(log), '参照: 「' + file + '」\r\n読込: ' + file + ': error\n' +
    '元: ' + file + ' -> ' + share + '\n"' + share + '"\n' +
    JSON.stringify({ input_path: file, error: 'ファイル: ' + share, name: prefix + file }));
  for (const text of ['file=' + prefix + 'C:\\NUL.txt', "failed ('" + prefix + 'C:\\dir. ' + "')",
    'https://example/?path=' + prefix + file, 'text' + prefix + file, 'https://example/?a=b', '']) {
    assert.equal(displayText(text), text);
  }
});

test('既存のPBF・DEM診断、複数パスや日本語の区切りを保持する', () => {
  for (const [raw, shown] of [
    ['opening PBF ' + prefix + file + ': access denied', 'opening PBF ' + file + ': access denied'],
    ['DEM入力 ' + prefix + file + ' 内の foo/bar.xml', 'DEM入力 ' + file + ' 内の foo/bar.xml'],
    ['ログ：' + prefix + file + '。', 'ログ：' + file + '。'],
    ['候補：' + prefix + file + '、' + extendedShare, '候補：' + file + '、' + share],
    ['paths: ' + prefix + file + ', ' + extendedShare, 'paths: ' + file + ', ' + share],
    ['"' + prefix + file + '" → "' + extendedShare + '"', '"' + file + '" → "' + share + '"'],
  ]) assert.equal(displayText(raw), shown);
  for (const raw of ['入力: ' + prefix + 'C:\\末尾 ', '入力：「' + prefix + 'C:\\末尾.」',
    '参照: ' + prefix + 'C:\\末尾.。', JSON.stringify({ 表示名: prefix + file })]) {
    assert.equal(displayText(raw), raw);
  }
});
