import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    maxWorkers: 1,
    pool: "threads",
    restoreMocks: true,
    coverage: {
      provider: "custom",
      customProviderModule: "./tests/support/vm-coverage-provider.mjs",
      include: ["src/**/*.ts"],
      exclude: ["**/*.d.ts", "**/__tests__/**", "**/test/**"],
      reporter: ["text", "html", "json", "json-summary", "lcov"],
      reportsDirectory: "./coverage",
      reportOnFailure: true,
    },
  },
});
