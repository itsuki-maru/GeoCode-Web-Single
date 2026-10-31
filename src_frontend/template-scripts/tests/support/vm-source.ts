import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runInContext, type Context } from "node:vm";

/** 変更していないファイル全体を実行し、切り出し・結合したスクリプトには名前を付けない。 */
export function runSource(context: Context, sourcePath: string) {
  const filename = resolve(sourcePath);
  const fromRoot = relative(
    resolve(dirname(fileURLToPath(import.meta.url)), "../../src"),
    filename,
  );
  if (fromRoot.startsWith("..") || fromRoot.includes(":") || !fromRoot.endsWith(".ts")) {
    throw new Error("VM coverage requires a complete TypeScript source under src/");
  }
  const source = readFileSync(filename, "utf8");
  const url = pathToFileURL(filename);
  url.searchParams.set("geocode-vm", createHash("sha256").update(source).digest("hex"));
  return runInContext(`"use strict";\n${source}`, context, { filename: url.href });
}
