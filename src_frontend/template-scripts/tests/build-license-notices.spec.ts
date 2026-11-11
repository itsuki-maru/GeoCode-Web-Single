import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createBundledNotices } from "../build-license-notices";

const temporaryParent = realpathSync(tmpdir());
const fixtures: string[] = [];
function fixture() {
  const directory = mkdtempSync(join(temporaryParent, "geocode-licenses-"));
  fixtures.push(directory);
  return directory;
}
function packageAt(root: string, name: string, version = "1.0.0", dependencies?: Record<string, string>) {
  const directory = join(root, "node_modules", name);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "package.json"), JSON.stringify({ name, version, dependencies }));
  writeFileSync(join(directory, "index.js"), "export default 1;");
  writeFileSync(join(directory, "LICENSE"), `Copyright ${name} ${version}\nPermission is hereby granted, fixture notice.`);
  return directory;
}
function maps(directory: string, main: string[] = [], worker: string[] = []) {
  mkdirSync(join(directory, "dist"), { recursive: true });
  for (const [filename, sources] of [["maplibre-gl.mjs.map", main], ["maplibre-gl-worker.mjs.map", worker]] as const)
    writeFileSync(join(directory, "dist", filename), JSON.stringify({ version: 3, sources }));
}
afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    const absolute = realpathSync(fixture);
    expect(dirname(absolute)).toBe(temporaryParent);
    expect(basename(absolute)).toMatch(/^geocode-licenses-/);
    rmSync(absolute, { recursive: true, force: true });
  }
});

describe("bundled license notices", () => {
  it("includes MapLibre main/Worker source-map vendors and runtime-only nested dependency versions", () => {
    const root = fixture();
    const maplibre = packageAt(root, "maplibre-gl", "6.17.0", { worker: "*", shared: "*" });
    const worker = packageAt(root, "worker", "1.0.0", { shared: "*" });
    packageAt(root, "shared", "1.0.0");
    packageAt(worker, "shared", "2.0.0");
    packageAt(root, "@vendor/only-main");
    packageAt(root, "only-worker");
    const ordinary = packageAt(root, "ordinary");
    mkdirSync(join(ordinary, "dist", "esm"), { recursive: true });
    writeFileSync(join(ordinary, "dist", "esm", "package.json"), '{"type":"module"}');
    maps(maplibre, ["../node_modules/@vendor/only-main/index.js"], ["../node_modules/only-worker/index.js"]);
    const notices = createBundledNotices([join(maplibre, "index.js"), join(ordinary, "dist/esm/index.js")]);
    for (const name of ["maplibre-gl 6.17.0", "@vendor/only-main 1.0.0", "only-worker 1.0.0", "worker 1.0.0", "shared 1.0.0", "shared 2.0.0", "ordinary 1.0.0"])
      expect(notices).toContain(`Copyright ${name}`);
  });

  it("retains an upstream README license section when the package has no LICENSE file", () => {
    const root = fixture();
    const pkg = packageAt(root, "readme-license");
    rmSync(join(pkg, "LICENSE"));
    writeFileSync(join(pkg, "README.md"), "# Description\nUnrelated README text.\n\n## License (MIT)\n\nCopyright (c) Fixture Author\n\nPermission is hereby granted, free of charge, to retain this supplied license notice.\n\n## Other\nNot part of the license.");
    const notices = createBundledNotices([join(pkg, "index.js")]);
    expect(notices).toContain("Copyright (c) Fixture Author");
    expect(notices).toContain("Permission is hereby granted");
    expect(notices).not.toContain("Unrelated README");
    expect(notices).not.toContain("Not part of the license");
  });

  it("fails rather than omitting a bundled source that cannot be resolved", () => {
    const root = fixture();
    const maplibre = packageAt(root, "maplibre-gl");
    maps(maplibre, [], ["../node_modules/missing-vendor/index.js"]);
    expect(() => createBundledNotices([join(maplibre, "index.js")])).toThrow("Bundled dependency missing-vendor");
  });

  it("fails if MapLibre source-map inventory or a complete license is unavailable", () => {
    const root = fixture();
    const maplibre = packageAt(root, "maplibre-gl");
    expect(() => createBundledNotices([join(maplibre, "index.js")])).toThrow("MapLibre bundled source map missing");
    maps(maplibre);
    rmSync(join(maplibre, "LICENSE"));
    writeFileSync(join(maplibre, "README.md"), "## License\nMIT\n");
    expect(() => createBundledNotices([join(maplibre, "index.js")])).toThrow("Complete license notice missing");
  });

  it("includes actual pinned MapLibre vendors and the supplied murmurhash-js README notice", () => {
    const notices = createBundledNotices([resolve("node_modules/maplibre-gl/dist/maplibre-gl.mjs")]);
    for (const pkg of ["gl-matrix 3.4.4", "@mapbox/point-geometry 1.1.0", "@maplibre/mlt 1.3.0", "murmurhash-js 1.0.0"])
      expect(notices).toContain(`${pkg}\n`);
    expect(notices).toContain("Copyright (c) 2011 Gary Court");
    expect(notices).toContain("The above copyright notice and this permission notice shall be included");
  });
});
