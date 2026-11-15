import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, basename, resolve } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import {
  differences,
  hashes,
  inventory,
  normalize,
  workspace,
} from "../scripts/check-frontend-compat.mjs";

test("改行と製品版番号だけを正規化し依存関係の差を検出する", () => {
  const path = "src_frontend/frontend/package-lock.json";
  const lock = (version, dependency) =>
    Buffer.from(
      JSON.stringify({
        version,
        lockfileVersion: 3,
        packages: {
          "": { version },
          "node_modules/example": { version: dependency },
        },
      }),
    );
  assert.deepEqual(
    normalize(path, lock("1.14.0", "2.0.0")),
    normalize(path, lock("1.40.0", "2.0.0")),
  );
  assert.notDeepEqual(
    normalize(path, lock("1.14.0", "2.0.0")),
    normalize(path, lock("1.40.0", "2.1.0")),
  );
  assert.deepEqual(
    normalize("src/templates/map.html", Buffer.from("a\r\nb\r\n")),
    Buffer.from("a\nb\n"),
  );
  const binary = Buffer.from([0, 13, 10, 255]);
  assert.deepEqual(
    normalize("src_frontend/frontend/public/image.png", binary),
    binary,
  );
});

test("ライセンスの版表示以外を無視せず不足した表示も拒否する", () => {
  const path = "src_frontend/frontend/public/licenses.html";
  const first = normalize(
    path,
    Buffer.from("GeoCode-Web Version 1.14.0\nDependency 1.14.0"),
  );
  const next = normalize(
    path,
    Buffer.from("GeoCode-Web Version 1.40.0\nDependency 1.14.0"),
  );
  assert.deepEqual(first, next);
  assert.notDeepEqual(
    first,
    normalize(
      path,
      Buffer.from("GeoCode-Web Version 1.40.0\nDependency 1.40.0"),
    ),
  );
  assert.throws(() => normalize(path, Buffer.from("no version")), /一意/);
});

test("内容差だけでなく片側だけのファイルも失敗対象にする", () => {
  assert.deepEqual(
    differences(
      { a: "first", b: "same", missing: "value" },
      { a: "changed", b: "same", extra: "value" },
    ),
    [
      { path: "a", kind: "内容差" },
      { path: "extra", kind: "余剰" },
      { path: "missing", kind: "欠落" },
    ],
  );
});

test("全フロント領域と設定例を調べ生成物や実環境設定を比較しない", async () => {
  const root = await mkdtemp(join(tmpdir(), "frontend-compat-"));
  try {
    const paths = [
      "src_frontend/scripts/build.ps1",
      "src_frontend/main/MEMO.txt",
      "src_frontend/SPECIFICATION.md",
      "src_frontend/frontend/.env.example",
      "src/templates/map.html",
      "src_frontend/frontend/.env.local",
      "src_frontend/frontend/node_modules/module/index.js",
      "src_frontend/main/dist/old-local-tiles.js",
    ];
    for (const path of paths) {
      await mkdir(join(root, path, ".."), { recursive: true });
      await writeFile(join(root, path), path);
    }
    const files = await inventory(root);
    assert.deepEqual(
      [...files.keys()],
      paths.slice(0, 5).sort((a, b) => a.localeCompare(b, "en")),
    );
    const before = hashes(files);
    files.set("src_frontend/frontend/LocalTiles.vue", Buffer.from("独自画面"));
    assert.deepEqual(differences(before, hashes(files)), [
      { path: "src_frontend/frontend/LocalTiles.vue", kind: "余剰" },
    ]);
  } finally {
    // OS一時領域にこの試験が作った専用ディレクトリだけを削除する。
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert.ok(basename(root).startsWith("frontend-compat-"));
    await rm(root, { recursive: true, force: true });
  }
});

test("このリポジトリは固定したPostgreSQL採用基準と一致する", () => {
  const output = execFileSync(
    process.execPath,
    ["scripts/check-frontend-compat.mjs"],
    { cwd: workspace, encoding: "utf8" },
  );
  assert.match(output, /フロント互換性: OK/);
  assert.match(output, /93000f0d201612ca83958599ed889630779ce3e5/);
});

test("実コマンドは独自ファイル・欠落・内容改変で非0を返す", async () => {
  const root = await mkdtemp(join(tmpdir(), "frontend-compat-cli-"));
  try {
    const files = new Map();
    for (const project of [
      "frontend",
      "frontend-admin",
      "frontend-mobile",
      "template-scripts",
    ]) {
      const prefix = `src_frontend/${project}`;
      files.set(
        `${prefix}/package.json`,
        Buffer.from(JSON.stringify({ version: "1.14.0" })),
      );
      files.set(
        `${prefix}/package-lock.json`,
        Buffer.from(
          JSON.stringify({
            version: "1.14.0",
            lockfileVersion: 3,
            packages: { "": { version: "1.14.0" } },
          }),
        ),
      );
    }
    files.set(
      "src_frontend/frontend/public/licenses.html",
      Buffer.from("GeoCode-Web Version 1.14.0"),
    );
    files.set("src/templates/map.html", Buffer.from("共通テンプレート"));
    for (const [path, bytes] of files) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), bytes);
    }
    const fixtureBaseline = join(root, "baseline.json");
    await writeFile(
      fixtureBaseline,
      JSON.stringify({
        format: 1,
        source_ref: "c902196ccdc2c1b347040c003bdcd6517f281bc4",
        normalization: "utf8-crlf-and-product-version-v1",
        files: hashes(files),
      }),
    );
    const invoke = () =>
      spawnSync(
        process.execPath,
        [
          "scripts/check-frontend-compat.mjs",
          "--target-root",
          root,
          "--baseline",
          fixtureBaseline,
        ],
        { cwd: workspace, encoding: "utf8" },
      );
    assert.equal(invoke().status, 0);
    const localOnly = join(root, "src_frontend/frontend/LocalTiles.vue");
    await writeFile(localOnly, "SQLite専用画面");
    let result = invoke();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /余剰:.*LocalTiles\.vue/);
    await unlink(localOnly);
    const template = join(root, "src/templates/map.html");
    await writeFile(template, "共通仕様と異なる内容");
    result = invoke();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /内容差:.*map\.html/);
    await unlink(template);
    result = invoke();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /欠落:.*map\.html/);
  } finally {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert.ok(basename(root).startsWith("frontend-compat-cli-"));
    await rm(root, { recursive: true, force: true });
  }
});
