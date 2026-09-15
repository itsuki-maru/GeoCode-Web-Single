import { defineConfig, mergeConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

import viteConfig from "./vite.config";

export default mergeConfig(
  viteConfig,
  defineConfig({
    server: { fs: { allow: [fileURLToPath(new URL("../", import.meta.url))] } },
    test: {
      environment: "jsdom",
      setupFiles: ["./src/test/setup.ts"],
      pool: "threads",
      maxWorkers: 1,
      clearMocks: true,
      mockReset: true,
      restoreMocks: true,
    },
  }),
);
