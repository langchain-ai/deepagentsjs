import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    hideSkippedTests: true,
    globals: true,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    exclude: [...configDefaults.exclude],
    include: ["src/**/*.test.ts"],
  },
});
