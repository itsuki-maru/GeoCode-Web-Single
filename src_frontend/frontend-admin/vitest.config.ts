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
      coverage: {
        provider: "v8",
        include: ["src/**/*.{ts,vue}"],
        exclude: ["**/*.d.ts", "**/__tests__/**", "**/test/**"],
        reporter: ["text", "html", "json", "json-summary", "lcov"],
        reportsDirectory: "./coverage",
        reportOnFailure: true,
      },
    },
  }),
);
