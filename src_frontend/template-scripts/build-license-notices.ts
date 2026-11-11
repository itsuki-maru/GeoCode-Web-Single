import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";

type Package = {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};
type InstalledPackage = { directory: string; manifest: Package };

function installedPackage(directory: string): InstalledPackage {
  const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8")) as Package;
  if (!manifest.name || !manifest.version) throw Error(`Invalid package manifest: ${directory}`);
  return { directory: realpathSync(directory), manifest };
}

function owningPackage(moduleId: string): InstalledPackage | undefined {
  if (moduleId.startsWith("\0")) return;
  const filename = moduleId.split("?")[0]!.replaceAll("\\", "/");
  const boundary = filename.lastIndexOf("/node_modules/");
  if (boundary === -1) return;
  const parts = filename.slice(boundary + "/node_modules/".length).split("/");
  const name = parts[0]!.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
  // dist/esm/package.jsonには{type:'module'}だけが含まれる場合がある。実際のライセンス表記は
  // 最後のnode_modulesディレクトリ直下にあるパッケージから取得する。
  return installedPackage(join(filename.slice(0, boundary), "node_modules", name));
}

function resolveDependency(name: string, from: InstalledPackage): InstalledPackage | undefined {
  let directory = from.directory;
  for (;;) {
    const candidate = join(directory, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) return installedPackage(candidate);
    const parent = dirname(directory);
    if (parent === directory) return;
    directory = parent;
  }
}

function licenseText({ directory, manifest }: InstalledPackage): string {
  const filenames = readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isFile() && /(^|[-_])(licen[cs]e|copying|notice)([._-]|$)/i.test(entry.name))
    .map(entry => entry.name)
    .sort();
  if (filenames.length) return filenames.map(name => readFileSync(join(directory, name), "utf8")).join("\n");

  // murmurhash-js 1.0.0など、LICENSEファイルの代わりにREADMEへライセンス全文を載せる
  // 公開パッケージもある。その場合は提供された該当セクションだけを保持する。
  const readme = readdirSync(directory, { withFileTypes: true })
    .find(entry => entry.isFile() && /^readme(?:\.md|\.markdown|\.txt)?$/i.test(entry.name));
  if (readme) {
    const text = readFileSync(join(directory, readme.name), "utf8");
    const heading = /^(#{1,6})\s+Licen[cs]e\b[^\r\n]*\r?$/im.exec(text);
    if (heading) {
      const following = text.slice(heading.index + heading[0].length);
      const nextHeading = new RegExp(`^#{1,${heading[1]!.length}}\\s`, "m").exec(following);
      const section = following.slice(0, nextHeading?.index).trim();
      if (/copyright/i.test(section) && /permission is hereby granted|redistribution and use/i.test(section))
        return `${heading[0].trim()}\n\n${section}`;
    }
  }
  throw Error(`Complete license notice missing for ${manifest.name} ${manifest.version}`);
}

/** MapLibreのビルド済み本体・Workerバンドルに含まれる実行時依存のライセンス表記も収集する。 */
export function createBundledNotices(moduleIds: Iterable<string>): string {
  const packages = new Map<string, InstalledPackage>();
  for (const id of moduleIds) {
    const owner = owningPackage(id);
    if (owner) packages.set(owner.directory, owner);
  }

  const visited = new Set<string>();
  const addRuntimeTree = (pkg: InstalledPackage) => {
    packages.set(pkg.directory, pkg);
    if (visited.has(pkg.directory)) return;
    visited.add(pkg.directory);
    const optional = pkg.manifest.optionalDependencies ?? {};
    for (const name of new Set([...Object.keys(pkg.manifest.dependencies ?? {}), ...Object.keys(optional)])) {
      const dependency = resolveDependency(name, pkg);
      if (!dependency) {
        if (Object.hasOwn(optional, name)) continue;
        throw Error(`Runtime dependency ${name} missing for ${pkg.manifest.name} ${pkg.manifest.version}`);
      }
      addRuntimeTree(dependency);
    }
  };

  for (const pkg of [...packages.values()]) {
    if (pkg.manifest.name !== "maplibre-gl") continue;
    addRuntimeTree(pkg);
    for (const filename of ["maplibre-gl.mjs.map", "maplibre-gl-worker.mjs.map"]) {
      const sourceMapPath = join(pkg.directory, "dist", filename);
      if (!existsSync(sourceMapPath)) throw Error(`MapLibre bundled source map missing: ${filename}`);
      const sourceMap = JSON.parse(readFileSync(sourceMapPath, "utf8")) as { sources?: unknown };
      if (!Array.isArray(sourceMap.sources) || !sourceMap.sources.every(source => typeof source === "string"))
        throw Error(`Invalid MapLibre bundled source map: ${filename}`);
      for (const source of sourceMap.sources as string[]) {
        // npmが異なる2バージョンを入れ子に配置した場合は、最後のnode_modulesを優先する。
        const references = [...source.replaceAll("\\", "/").matchAll(/(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)/g)];
        const name = references.at(-1)?.[1];
        if (!name) continue;
        const dependency = resolveDependency(name, pkg);
        if (!dependency) throw Error(`Bundled dependency ${name} from ${filename} is not installed`);
        addRuntimeTree(dependency);
      }
    }
  }

  return [...packages.values()]
    .sort((a, b) => a.manifest.name.localeCompare(b.manifest.name) || a.manifest.version.localeCompare(b.manifest.version))
    .map(pkg => `${pkg.manifest.name} ${pkg.manifest.version}\n${licenseText(pkg)}`)
    .join("\n\n--------------------\n\n");
}
