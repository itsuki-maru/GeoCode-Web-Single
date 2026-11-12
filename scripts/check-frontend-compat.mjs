#!/usr/bin/env node
// PostgreSQL採用版と共通フロント全体を照合する。DBや生成物には書き込まない。
import { createHash } from "node:crypto";
import { lstat, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve, relative, isAbsolute, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const baselinePath = resolve(
  workspace,
  "tests/fixtures/frontend-compat-baseline.json",
);
export const scopes = ["src_frontend", "src/templates"];
const generated = new Set([
  "node_modules",
  "dist",
  "coverage",
  ".git",
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
const projects = [
  "frontend",
  "frontend-admin",
  "frontend-mobile",
  "template-scripts",
];
const license = "src_frontend/frontend/public/licenses.html";

export function excluded(path) {
  const parts = path.split("/");
  const name = parts.at(-1);
  return (
    parts.some((part) => generated.has(part.toLowerCase())) ||
    (/^\.env(?:\..*)?$/.test(name) &&
      ![".env.example", ".env.sample"].includes(name)) ||
    /(?:\.(?:log|tsbuildinfo|pyc|tmp|temp)|~)$/.test(name) ||
    [".DS_Store", "Thumbs.db"].includes(name) ||
    name.startsWith(".sync-to-sqlite-")
  );
}

export function normalize(path, bytes) {
  const text = bytes.toString("utf8");
  if (
    projects.some(
      (project) =>
        path === `src_frontend/${project}/package.json` ||
        path === `src_frontend/${project}/package-lock.json`,
    )
  ) {
    const json = JSON.parse(text.replace(/^\uFEFF/, ""));
    json.version = "<product-version>";
    if (path.endsWith("package-lock.json")) {
      if (!json.packages?.[""] || ![2, 3].includes(json.lockfileVersion))
        throw Error(`未対応のlockfile: ${path}`);
      json.packages[""].version = "<product-version>";
    }
    return Buffer.from(JSON.stringify(json, null, 2) + "\n");
  }
  if (path === license) {
    const matches = [...text.matchAll(/\bGeoCode-Web Version ([^\s<>]+)/g)];
    if (matches.length !== 1)
      throw Error(`ライセンスの製品版表示が一意でありません: ${path}`);
    return Buffer.from(
      text
        .replace(
          /\bGeoCode-Web Version ([^\s<>]+)/,
          "GeoCode-Web Version <product-version>",
        )
        .replace(/\r\n/g, "\n"),
    );
  }
  // バイナリはそのまま比較し、UTF-8テキストだけ改行を正規化する。
  return !bytes.includes(0) && Buffer.from(text).equals(bytes)
    ? Buffer.from(text.replace(/\r\n/g, "\n"))
    : bytes;
}

export async function inventory(root) {
  const files = new Map();
  async function walk(path) {
    if (excluded(path)) return;
    const absolute = resolve(root, path);
    const info = await lstat(absolute);
    if (info.isSymbolicLink())
      throw Error(`リンク経路は比較できません: ${path}`);
    if (info.isDirectory()) {
      for (const name of (await readdir(absolute)).sort())
        await walk(`${path}/${name}`);
    } else if (info.isFile()) files.set(path, await readFile(absolute));
    else throw Error(`通常ファイルではありません: ${path}`);
  }
  for (const scope of scopes) await walk(scope);
  return new Map([...files].sort(([a], [b]) => a.localeCompare(b, "en")));
}

export function hashes(files) {
  return Object.fromEntries(
    [...files].map(([path, bytes]) => [
      path,
      createHash("sha256").update(normalize(path, bytes)).digest("hex"),
    ]),
  );
}

export function differences(expected, actual) {
  const paths = new Set([...Object.keys(expected), ...Object.keys(actual)]);
  return [...paths].sort().flatMap((path) =>
    expected[path] === actual[path]
      ? []
      : [
          {
            path,
            kind: !(path in expected)
              ? "余剰"
              : !(path in actual)
                ? "欠落"
                : "内容差",
          },
        ],
  );
}

export async function validateVersions(files) {
  for (const project of projects) {
    const path = `src_frontend/${project}`;
    const pkg = JSON.parse(files.get(`${path}/package.json`).toString("utf8"));
    const lock = JSON.parse(
      files.get(`${path}/package-lock.json`).toString("utf8"),
    );
    if (
      !pkg.version ||
      pkg.version !== lock.version ||
      pkg.version !== lock.packages?.[""]?.version
    )
      throw Error(`製品versionの不整合: ${path}`);
  }
  const pc = JSON.parse(
    files.get("src_frontend/frontend/package.json").toString("utf8"),
  );
  if (
    !files
      .get(license)
      .toString("utf8")
      .includes(`GeoCode-Web Version ${pc.version}`)
  )
    throw Error("ライセンスの表示版とpackage versionが一致しません。");
}

async function main(args) {
  let sourceRoot;
  let targetRoot = workspace;
  let comparisonBaseline = baselinePath;
  let writeBaseline = false;
  let sourceRef;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--source-root" && args[i + 1])
      sourceRoot = resolve(args[++i]);
    else if (args[i] === "--target-root" && args[i + 1])
      targetRoot = resolve(args[++i]);
    else if (args[i] === "--baseline" && args[i + 1])
      comparisonBaseline = resolve(args[++i]);
    else if (args[i] === "--write-baseline") writeBaseline = true;
    else if (args[i] === "--source-ref" && args[i + 1]) sourceRef = args[++i];
    else if (["--help", "-h"].includes(args[i])) {
      console.log(
        "使い方: node scripts/check-frontend-compat.mjs [--source-root PostgreSQL版root] [--target-root SQLite版root] [--baseline JSON]\n採用基準の更新: --write-baseline --source-root PATH --source-ref COMMIT",
      );
      return;
    } else throw Error(`不明または不足した引数: ${args[i]}`);
  }
  if (writeBaseline) {
    if (comparisonBaseline !== baselinePath || targetRoot !== workspace)
      throw Error("基準更新の保存先はこのリポジトリの固定ファイルだけです。");
    if (!sourceRoot || !/^[a-f0-9]{40}$/.test(sourceRef || ""))
      throw Error("基準更新には比較元と40桁の採用commitが必要です。");
    const rel = relative(workspace, baselinePath);
    if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`))
      throw Error("基準の保存先がworkspace外です。");
    const source = await inventory(sourceRoot);
    await validateVersions(source);
    await writeFile(
      baselinePath,
      JSON.stringify(
        {
          format: 1,
          repository: "itsuki-maru/GeoCode-Web",
          source_ref: sourceRef,
          normalization: "utf8-crlf-and-product-version-v1",
          files: hashes(source),
        },
        null,
        2,
      ) + "\n",
    );
    console.log(`採用基準を保存: ${sourceRef}, ${source.size} files`);
    return;
  }
  const baseline = JSON.parse(await readFile(comparisonBaseline, "utf8"));
  if (
    baseline.format !== 1 ||
    baseline.normalization !== "utf8-crlf-and-product-version-v1" ||
    !/^[a-f0-9]{40}$/.test(baseline.source_ref || "") ||
    !baseline.files
  )
    throw Error("フロント採用基準が不正です。");
  if (sourceRoot) {
    const source = await inventory(sourceRoot);
    await validateVersions(source);
    const sourceDiff = differences(baseline.files, hashes(source));
    if (sourceDiff.length)
      throw Error(
        `比較元が採用基準と一致しません:\n${sourceDiff.map((diff) => `${diff.kind}: ${diff.path}`).join("\n")}`,
      );
  }
  const target = await inventory(targetRoot);
  await validateVersions(target);
  const diffs = differences(baseline.files, hashes(target));
  for (const diff of diffs) console.error(`${diff.kind}: ${diff.path}`);
  if (diffs.length)
    throw Error(`共通フロントに${diffs.length}件の差分があります。`);
  console.log(
    `フロント互換性: OK (${target.size} files, PostgreSQL ${baseline.source_ref})`,
  );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`互換性検査失敗: ${error.message}`);
    process.exitCode = 1;
  });
}
