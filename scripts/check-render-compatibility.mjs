#!/usr/bin/env node
// 小さな検証crateだけを使い、描画世代とは独立した互換性判断の記録を照合する。
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const cargoArgs = ['run', '--locked', '--manifest-path', resolve(root, 'scripts/render-compatibility/Cargo.toml'),
  '--target-dir', resolve(root, 'target/render-identity-verification/tools')];
if (args.includes('--offline')) cargoArgs.push('--offline');
cargoArgs.push('--', '--root', root, ...args);
const result = spawnSync('cargo', cargoArgs, {
  cwd: root, stdio: 'inherit', windowsHide: true,
  env: { ...process.env, CARGO_PROFILE_DEV_DEBUG: '0', CARGO_INCREMENTAL: '0' },
});
if (result.error) console.error(`互換性検査を起動できません: ${result.error.message}`);
process.exitCode = result.status ?? 1;
