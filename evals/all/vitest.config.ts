import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    testTimeout: 120_000,
    hookTimeout: 60_000,
    teardownTimeout: 60_000,
    include: ["../*/index.test.ts", "../oolong/datasets/*.test.ts"],
    exclude: ["../all/**"],
    setupFiles: ["@deepagents/evals/setup"],
    reporters: ["langsmith/vitest/reporter"],
  },
});
