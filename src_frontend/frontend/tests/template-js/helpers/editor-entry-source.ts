import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";

import {
  editorEntrySources,
  type EditorEntryName,
} from "../../../../template-scripts/src/entries/editor-entry-sources";
const PACKAGE_DIRECTORY = resolve(process.cwd(), "../template-scripts");
const viteConfigSource = readFileSync(resolve(PACKAGE_DIRECTORY, "vite.config.ts"), "utf8");

function readViteSourceBlock(name: string): string {
  const match = viteConfigSource.match(
    new RegExp("export const " + name + " = `([\\s\\S]*?)`;"),
  );
  if (!match) throw new Error(`Vite editor source block was not found: ${name}`);
  return match[1];
}

const editorCommonPrelude = readViteSourceBlock("editorCommonPrelude");
const editorFocusBridge = readViteSourceBlock("editorFocusBridge");

export function editorImplementationScriptNames(entryName: EditorEntryName): string[] {
  return editorEntrySources[entryName].map((path) => basename(path));
}

export function editorSourcePath(relativePath: string): string {
  return resolve(PACKAGE_DIRECTORY, relativePath);
}

/**
 * Reuses the production entry assembly in jsdom, replacing only ESM imports
 * with values installed on the test window.
 */
export function editorRuntimeSource(entryName: EditorEntryName): string {
  const runtimePrelude = editorCommonPrelude.replace(
    /^import \{ ([^}]+) \} from "[^"]+";$/gm,
    "const { $1 } = globalThis;",
  );
  const profile = `const editorEntryProfile = Object.freeze({
    isMobile: ${entryName === "map-mobile"},
    interactionVerb: "${entryName === "map-mobile" ? "タップ" : "クリック"}",
  });`;
  const sources = editorEntrySources[entryName]
    .map((relativePath) => {
      const focusBridge = relativePath.endsWith("map-editor-final.ts")
        ? editorFocusBridge
        : "";
      return `${focusBridge}\n${readFileSync(editorSourcePath(relativePath), "utf8")}`;
    })
    .join("\n");
  return `${runtimePrelude}\n${profile}\n${sources}`;
}
