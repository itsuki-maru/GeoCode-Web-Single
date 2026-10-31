import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { URL, fileURLToPath } from "node:url";
import { V8CoverageProvider } from "@vitest/coverage-v8/dist/provider.js";

// Vitest 標準の V8 データ収集、AST 対応付け、対象・除外ルールを維持する。
// getSources は内部フックのため、更新時は安全側に失敗させ、行への対応付けを検証する。
export class VmCoverageProvider extends V8CoverageProvider {
  constructor() {
    super();
    this.name = "custom";
    if (this.version !== "4.1.11")
      throw new Error("Revalidate VM coverage for this Vitest version");
  }
  async getSources(url, onTransform, functions = []) {
    const id = new URL(url);
    const digest = id.searchParams.get("geocode-vm");
    if (!digest) return super.getSources(url, onTransform, functions);
    const code = await readFile(fileURLToPath(id), "utf8");
    if (createHash("sha256").update(code).digest("hex") !== digest) {
      throw new Error(`VM source changed during coverage collection: ${id.pathname}`);
    }
    // 生の VM オフセットは、Vite 変換後のソースではなく、変換前のソースに対応する。
    return { code };
  }
}
