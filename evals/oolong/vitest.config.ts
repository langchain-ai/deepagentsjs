import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    testTimeout: 600_000, // 10 min — long-context aggregation tasks
    hookTimeout: 120_000, // 2 min — dataset download on first run
    teardownTimeout: 60_000,
    setupFiles: ["./vitest.setup.ts"],
    include: ["datasets/**/*.test.ts"],
    reporters: ["langsmith/vitest/reporter"],
  },
});
