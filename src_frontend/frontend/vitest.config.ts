import { defineConfig, mergeConfig } from "vitest/config";

import viteConfig from "./vite.config";

export default mergeConfig(
  viteConfig,
  defineConfig({
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
