import { URL } from "node:url";
import v8 from "@vitest/coverage-v8";

export default {
  ...v8,
  async takeCoverage(options) {
    const coverage = await v8.takeCoverage(options);
    for (const entry of coverage.result) {
      if (new URL(entry.url).searchParams.has("geocode-vm")) {
        entry.startOffset = '"use strict";\n'.length;
      }
    }
    return coverage;
  },
  async getProvider() {
    const { VmCoverageProvider } = await import("./vm-coverage-server.mjs");
    return new VmCoverageProvider();
  },
};
