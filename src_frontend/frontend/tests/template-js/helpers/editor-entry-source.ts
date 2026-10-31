import { readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Script, type Context } from "node:vm";
import { runSource } from "../../../../template-scripts/tests/support/vm-source";

import {
  editorEntrySources,
  type EditorEntryName,
} from "../../../../template-scripts/src/entries/editor-entry-sources";
const PACKAGE_DIRECTORY = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../template-scripts",
);
const viteConfigSource = readFileSync(resolve(PACKAGE_DIRECTORY, "vite.config.ts"), "utf8");

function readViteSourceBlock(name: string): string {
  const match = viteConfigSource.match(new RegExp("export const " + name + " = `([\\s\\S]*?)`;"));
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
 * 本番用のエントリー組み立て処理を jsdom で再利用し、ESM のインポートだけを
 * テスト用のウィンドウに設定した値へ置き換える。
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
      const focusBridge = relativePath.endsWith("map-editor-final.ts") ? editorFocusBridge : "";
      return `${focusBridge}\n${readFileSync(editorSourcePath(relativePath), "utf8")}`;
    })
    .join("\n");
  return `${runtimePrelude}\n${profile}\n${sources}`;
}

/** 本番と同じ共有スコープを維持し、変更していない各ファイルを個別に計測する。 */
export function runEditorRuntime(context: Context, entryName: EditorEntryName) {
  const prelude = editorCommonPrelude.replace(
    /^import \{ ([^}]+) \} from "[^"]+";$/gm,
    "const { $1 } = globalThis;",
  );
  new Script(`"use strict";\n${prelude}\nconst editorEntryProfile = Object.freeze({
    isMobile: ${entryName === "map-mobile"},
    interactionVerb: "${entryName === "map-mobile" ? "タップ" : "クリック"}"
  });`).runInContext(context);
  for (const path of editorEntrySources[entryName]) {
    if (path.endsWith("map-editor-final.ts"))
      new Script(`"use strict";\n${editorFocusBridge}`).runInContext(context);
    runSource(context, editorSourcePath(path));
  }
}
