import { readdirSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";

import { JSDOM } from "jsdom";

const REPOSITORY_ROOT = resolve(process.cwd(), "../..");
const TEMPLATE_JS_DIRECTORY = resolve(REPOSITORY_ROOT, "src/templates/js");
const TEMPLATE_DIRECTORY = resolve(REPOSITORY_ROOT, "src/templates");

function collectTemplateJsPaths(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      return collectTemplateJsPaths(entryPath);
    }
    return entry.isFile() && entry.name.endsWith(".js") ? [entryPath] : [];
  });
}

const templateJsPathByFileName = new Map<string, string>();
for (const filePath of collectTemplateJsPaths(TEMPLATE_JS_DIRECTORY)) {
  const fileName = basename(filePath);
  const existingPath = templateJsPathByFileName.get(fileName);
  if (existingPath) {
    throw new Error(
      `Template JavaScript file names must be unique: ${fileName}\n${existingPath}\n${filePath}`,
    );
  }
  templateJsPathByFileName.set(fileName, filePath);
}

export const templateJsFileNames = Array.from(templateJsPathByFileName.keys()).sort();

export const mapCommonScriptNames = [
  "map-common-base.js",
  "map-common-shape-style.js",
  "map-common-shape-viewport.js",
  "map-common-search.js",
  "map-common-content.js",
  "map-common-storage.js",
  "map-common-marker.js",
  "map-common.js",
] as const;

export interface LoadedClassicScript<TApi extends object> {
  api: TApi;
  dom: JSDOM;
}

interface LoadClassicScriptOptions {
  body?: string;
  globals?: Record<string, unknown>;
  shapeStyle?: Record<string, unknown>;
  tileServers?: Record<string, unknown>;
  url?: string;
}

/**
 * Loads a production classic script in an isolated browser realm.
 *
 * The export bridge is appended only to the in-memory source. Production files
 * remain classic scripts and do not need test-only exports.
 */
export function loadMapCommon<TApi extends object>(
  exportedNames: readonly string[],
  options: LoadClassicScriptOptions = {},
): LoadedClassicScript<TApi> {
  const dom = new JSDOM(`<!doctype html><html><body>${options.body ?? ""}</body></html>`, {
    runScripts: "outside-only",
    url: options.url ?? "https://example.test/map",
  });

  const testGlobals = {
    ID_RE: /^[\w-]{11}$/,
    SHAPE_STYLE: {
      color: "#3388ff",
      fillOpacity: 0.2,
      weight: 5,
      ...options.shapeStyle,
    },
    tileServers: options.tileServers ?? {
      "1": { url: "https://tiles.example.test/default/{z}/{x}/{y}.png" },
      "2": { url: "https://tiles.example.test/alternate/{z}/{x}/{y}.png" },
    },
  };

  Object.assign(dom.window, options.globals, {
    __templateJsTestGlobals: testGlobals,
  });

  const source = mapCommonScriptNames
    .map((fileName) => readFileSync(templateJsPath(fileName), "utf8"))
    .join("");
  const exportRecord = exportedNames.map((name) => `${JSON.stringify(name)}: ${name}`).join(",\n");
  const instrumentedSource = `
    const ID_RE = globalThis.__templateJsTestGlobals.ID_RE;
    const SHAPE_STYLE = globalThis.__templateJsTestGlobals.SHAPE_STYLE;
    const tileServers = globalThis.__templateJsTestGlobals.tileServers;
    ${source}
    globalThis.__templateJsTestApi = { ${exportRecord} };
  `;

  dom.window.eval(instrumentedSource);

  return {
    api: (dom.window as unknown as { __templateJsTestApi: TApi }).__templateJsTestApi,
    dom,
  };
}

export function templateJsPath(fileName: string): string {
  const filePath = templateJsPathByFileName.get(fileName);
  if (!filePath) {
    throw new Error(`Template JavaScript was not found: ${fileName}`);
  }
  return filePath;
}

export function templateScriptNames(templateName: string): string[] {
  const template = readFileSync(resolve(TEMPLATE_DIRECTORY, templateName), "utf8");
  return Array.from(template.matchAll(/<script src="\/assets\/([^"?]+\.js)"><\/script>/g))
    .map((match) => match[1])
    .filter((fileName) => templateJsPathByFileName.has(fileName));
}
