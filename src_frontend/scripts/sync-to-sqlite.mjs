#!/usr/bin/env node
// PostgreSQL版の作業ツリーから、直下のSQLite版へフロントエンドを同期する。
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const projects = [
  "frontend",
  "frontend-admin",
  "frontend-mobile",
  "template-scripts",
];
const scopes = [
  "src/templates",
  ...projects.map((name) => `src_frontend/${name}`),
];
const licensePath = "src_frontend/frontend/public/licenses.html";
const excludedDirectories = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "dist",
  "coverage",
  ".cache",
  ".vite",
  ".vite-temp",
  ".vitest",
  ".nyc_output",
  ".turbo",
  ".parcel-cache",
  "playwright-report",
  "test-results",
  "__pycache__",
  ".pytest_cache",
]);
const help = `使い方: node src_frontend/scripts/sync-to-sqlite.mjs [オプション]

コピー先は、このスクリプトが属するプロジェクト直下の GeoCode-Web-Single です。
既定はプレビューのみで、ファイルやGitのインデックスを変更しません。

  --apply         追加・更新を適用する
  --delete        コピー元にない対象ファイルも削除候補にする（適用には --apply が必要）
  --target PATH   互換用の指定。直下の GeoCode-Web-Single と同じパスだけを許可する
  --help          この説明を表示する

バージョン情報、生成物、環境設定を保持し、コピー先の未コミット変更との衝突時は停止します。
詳細: src_frontend/scripts/README.md`;

function parseOptions(args) {
  const options = { apply: false, delete: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--apply") options.apply = true;
    else if (arg === "--delete") options.delete = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--target") {
      if (!args[i + 1] || args[i + 1].startsWith("--") || options.target) {
        throw Error("--target にはコピー先パスを1回だけ指定してください。");
      }
      options.target = resolve(args[++i]);
    } else throw Error(`不明な引数です: ${arg}\n${help}`);
  }
  return options;
}

async function statOrNull(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function samePath(a, b) {
  return relative(a, b) === "";
}

function git(root, args, { input, allowNoMatches = false } = {}) {
  try {
    return execFileSync("git", ["--no-optional-locks", "-C", root, ...args], {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      input,
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
  } catch (error) {
    if (allowNoMatches && error.status === 1) return error.stdout;
    throw Error(
      `Gitの確認に失敗しました: ${root}\n${error.stderr?.toString().trim() || error.message}`,
    );
  }
}

// 実際のコピー対象へ進む前に、配置・リンク・独立したGitルートを検証する。
async function validateLayout(source, options) {
  const target = resolve(source, "GeoCode-Web-Single");
  if (options.target && !samePath(target, options.target)) {
    throw Error(
      `コピー先はプロジェクト直下の GeoCode-Web-Single に限定しています: ${target}`,
    );
  }
  const targetStat = await statOrNull(target);
  if (!targetStat?.isDirectory() || targetStat.isSymbolicLink()) {
    throw Error(
      `プロジェクト直下に GeoCode-Web-Single の実ディレクトリが必要です: ${target}`,
    );
  }
  for (const root of [source, target]) {
    const top = await realpath(
      git(root, ["rev-parse", "--show-toplevel"]).trim(),
    );
    if (!samePath(top, root))
      throw Error(`独立したGitリポジトリが必要です: ${root}`);
    for (const scope of scopes) {
      const info = await inspectPath(root, scope);
      if (!info?.isDirectory())
        throw Error(`同期対象ディレクトリがありません: ${root}/${scope}`);
    }
  }
  const cargo = await readFile(resolve(target, "Cargo.toml"), "utf8");
  const packageSection = cargo.match(
    /^\[package\][ \t]*\r?\n([\s\S]*?)(?=^\[|(?![\s\S]))/m,
  )?.[1];
  if (
    !/^name\s*=\s*"geocode_web_single"\s*(?:#.*)?$/m.test(packageSection || "")
  ) {
    throw Error(
      "GeoCode-Web-Single/Cargo.toml の package.name が geocode_web_single ではありません。",
    );
  }
  return target;
}

function inScope(path) {
  return scopes.some((scope) => path.startsWith(`${scope}/`));
}

function excluded(path) {
  const parts = path.split("/");
  return (
    parts.some((part) => excludedDirectories.has(part.toLowerCase())) ||
    /^(?:\.env(?:\..*)?|\.DS_Store|Thumbs\.db|\.sync-to-sqlite-.*)$/i.test(
      parts.at(-1),
    ) ||
    /\.(?:log|tsbuildinfo|pyc|tmp|temp)$/i.test(path) ||
    path.endsWith("~")
  );
}

// 各経路をlstatで確認し、symlink/junction経由でコピー範囲を外れないようにする。
async function inspectPath(root, path) {
  const parts = path.split("/");
  if (
    isAbsolute(path) ||
    parts.some(
      (part) => !part || part === "." || part === ".." || part.includes("\\"),
    )
  ) {
    throw Error(`不正な相対パスです: ${path}`);
  }
  const absolute = resolve(root, ...parts);
  const rel = relative(root, absolute);
  if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) {
    throw Error(`対象範囲外のパスです: ${path}`);
  }
  let current = root;
  for (let i = 0; i < parts.length; i++) {
    current = resolve(current, parts[i]);
    const info = await statOrNull(current);
    if (!info) return null;
    if (info.isSymbolicLink())
      throw Error(`symlink/junctionは同期できません: ${current}`);
    if (i < parts.length - 1 && !info.isDirectory()) {
      throw Error(`親パスがディレクトリではありません: ${current}`);
    }
    if (i === parts.length - 1) return info;
  }
}

async function inventory(root) {
  const names = new Set(
    git(root, [
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "-z",
      "--",
      ...scopes,
    ])
      .split("\0")
      .filter(Boolean),
  );
  const files = new Map();
  for (const path of [...names].sort()) {
    if (!inScope(path) || excluded(path)) continue;
    const info = await inspectPath(root, path);
    if (!info) continue; // 作業ツリーで削除済みの追跡ファイル。
    if (!info.isFile())
      throw Error(`通常ファイルではありません: ${root}/${path}`);
    files.set(path, {
      bytes: await readFile(resolve(root, path)),
      mode: info.mode & 0o777,
    });
  }
  return files;
}

function parseJson(files, path, label) {
  const file = files.get(path);
  if (!file)
    throw Error(
      `${label}に必要なファイルがありません（Git除外設定も確認してください）: ${path}`,
    );
  try {
    const value = JSON.parse(
      file.bytes.toString("utf8").replace(/^\uFEFF/, ""),
    );
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw Error("objectではありません");
    return value;
  } catch (error) {
    throw Error(`${label}のJSONが不正です: ${path}: ${error.message}`);
  }
}

function applicationVersion(packageJson, lock, label) {
  const version = packageJson.version;
  if (
    typeof version !== "string" ||
    !version.trim() ||
    lock.version !== version ||
    lock.packages?.[""]?.version !== version ||
    ![2, 3].includes(lock.lockfileVersion)
  ) {
    throw Error(
      `${label}: package.json と package-lock.json のアプリバージョン・lockfile形式を確認してください。`,
    );
  }
  return version;
}

function licenseVersion(files, label) {
  const file = files.get(licensePath);
  if (!file) throw Error(`${label}に ${licensePath} がありません。`);
  const text = file.bytes.toString("utf8");
  const matches = [...text.matchAll(/\bGeoCode-Web Version ([^\s<>]+)/g)];
  if (matches.length !== 1)
    throw Error(
      `${label}: licenses.html のアプリバージョン表示を1か所にしてください。`,
    );
  return { text, version: matches[0][1] };
}

function retainVersions(sourceFiles, targetFiles) {
  const versions = new Map();
  for (const name of projects) {
    const packagePath = `src_frontend/${name}/package.json`;
    const lockPath = `src_frontend/${name}/package-lock.json`;
    const sourcePackage = parseJson(sourceFiles, packagePath, "コピー元");
    const sourceLock = parseJson(sourceFiles, lockPath, "コピー元");
    const targetPackage = parseJson(targetFiles, packagePath, "コピー先");
    const targetLock = parseJson(targetFiles, lockPath, "コピー先");
    const sourceVersion = applicationVersion(
      sourcePackage,
      sourceLock,
      `コピー元 ${name}`,
    );
    const version = applicationVersion(
      targetPackage,
      targetLock,
      `コピー先 ${name}`,
    );
    versions.set(name, { sourceVersion, version });
    sourcePackage.version = version;
    sourceLock.version = version;
    sourceLock.packages[""].version = version;
    for (const [path, json] of [
      [packagePath, sourcePackage],
      [lockPath, sourceLock],
    ]) {
      sourceFiles.get(path).bytes = Buffer.from(
        `${JSON.stringify(json, null, 2)}\n`,
      );
    }
  }
  const sourceLicense = licenseVersion(sourceFiles, "コピー元");
  const targetLicense = licenseVersion(targetFiles, "コピー先");
  const frontend = versions.get("frontend");
  if (
    sourceLicense.version !== frontend.sourceVersion ||
    targetLicense.version !== frontend.version
  ) {
    throw Error(
      "licenses.html と frontend/package.json のアプリバージョンが一致していません。",
    );
  }
  sourceFiles.get(licensePath).bytes = Buffer.from(
    sourceLicense.text.replace(
      /\bGeoCode-Web Version [^\s<>]+/,
      () => `GeoCode-Web Version ${targetLicense.version}`,
    ),
  );
  return versions;
}

// Gitのtext=autoと同様、NULを含まないUTF-8テキストの改行差だけは更新と扱わない。
function sameContents(a, b) {
  if (a.equals(b)) return true;
  if (a.includes(0) || b.includes(0)) return false;
  try {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    return (
      decoder.decode(a).replace(/\r\n/g, "\n") ===
      decoder.decode(b).replace(/\r\n/g, "\n")
    );
  } catch {
    return false;
  }
}

function dirtyPaths(target) {
  const entries = git(target, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
    "--",
    ...scopes,
  ]).split("\0");
  const paths = new Set();
  for (let i = 0; i < entries.length; i++) {
    if (!entries[i]) continue;
    const status = entries[i].slice(0, 2);
    paths.add(entries[i].slice(3));
    if (/[RC]/.test(status)) paths.add(entries[++i]);
  }
  return paths;
}

async function createPlan(source, target, options) {
  const sourceFiles = await inventory(source);
  const targetFiles = await inventory(target);
  const versions = retainVersions(sourceFiles, targetFiles);
  const operations = [];
  let unchanged = 0;
  let retained = 0;
  for (const [path, file] of sourceFiles) {
    const before = targetFiles.get(path);
    const info = await inspectPath(target, path);
    if (info && !info.isFile())
      throw Error(`コピー先が通常ファイルではありません: ${path}`);
    // target側でGit除外されている既存ファイルも、上書きせず停止する。
    if (info && !before)
      throw Error(`コピー先のGit除外ファイルと衝突します: ${path}`);
    if (before && sameContents(before.bytes, file.bytes)) unchanged++;
    else
      operations.push({ type: before ? "更新" : "追加", path, file, before });
  }
  const ignored = git(target, ["check-ignore", "-z", "--stdin"], {
    input: [...sourceFiles.keys()].join("\0") + "\0",
    allowNoMatches: true,
  })
    .split("\0")
    .filter(Boolean);
  if (ignored.length)
    throw Error(`コピー先のGit除外設定と衝突します: ${ignored.join(", ")}`);
  for (const [path, before] of targetFiles) {
    if (sourceFiles.has(path)) continue;
    if (options.delete) operations.push({ type: "削除", path, before });
    else retained++;
  }
  const dirty = dirtyPaths(target);
  const conflicts = operations
    .filter((op) => dirty.has(op.path))
    .map((op) => op.path);
  return { operations, versions, unchanged, retained, conflicts };
}

async function applyPlan(target, plan) {
  if (plan.conflicts.length)
    throw Error(
      "コピー先に未コミット変更との衝突があります。対象をコミットまたは退避してから再実行してください。",
    );
  // 全件を再検証してから書き込みを始める。
  for (const op of plan.operations) {
    const info = await inspectPath(target, op.path);
    if (op.before) {
      if (
        !info?.isFile() ||
        !(await readFile(resolve(target, op.path))).equals(op.before.bytes)
      ) {
        throw Error(`計画後にコピー先が変更されました: ${op.path}`);
      }
    } else if (info)
      throw Error(`計画後にコピー先が作成されました: ${op.path}`);
  }
  for (const op of plan.operations) {
    const destination = resolve(target, op.path);
    await inspectPath(target, op.path);
    if (op.type === "削除") {
      await unlink(destination); // ディレクトリの再帰削除は行わない。
      continue;
    }
    await mkdir(dirname(destination), { recursive: true });
    const temporary = resolve(
      dirname(destination),
      `.sync-to-sqlite-${randomUUID()}.tmp`,
    );
    try {
      await writeFile(temporary, op.file.bytes, { flag: "wx" });
      await chmod(temporary, op.file.mode);
      await rename(temporary, destination);
    } finally {
      await unlink(temporary).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  }
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  if (options.help) {
    console.log(help);
    return;
  }
  const source = await realpath(
    resolve(dirname(fileURLToPath(import.meta.url)), "../.."),
  );
  const target = await validateLayout(source, options);
  const plan = await createPlan(source, target, options);
  console.log(
    `${options.apply ? "適用" : "プレビュー"}: ${source} → ${target}`,
  );
  for (const [name, { version }] of plan.versions)
    console.log(`バージョン保持: ${name} ${version}`);
  for (const op of plan.operations) console.log(`${op.type}: ${op.path}`);
  for (const path of plan.conflicts)
    console.log(`衝突（未コミット変更）: ${path}`);
  console.log(
    `追加 ${plan.operations.filter((op) => op.type === "追加").length} / 更新 ${plan.operations.filter((op) => op.type === "更新").length} / 削除 ${plan.operations.filter((op) => op.type === "削除").length} / 変更なし ${plan.unchanged} / コピー先のみ保持 ${plan.retained}`,
  );
  if (options.apply) {
    await applyPlan(target, plan);
    console.log(
      "同期が完了しました。依存関係のインストール・ビルドは別途実行してください。",
    );
  } else
    console.log(
      "ファイルは変更していません。適用する場合は --apply を指定してください。",
    );
}

main().catch((error) => {
  console.error(`同期を中止しました: ${error.message}`);
  process.exitCode = 1;
});
