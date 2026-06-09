import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    // Per-test cap (30 min). Generous enough for legitimate large-N runs, but
    // a hard backstop so a runaway (e.g. an under-scoped baseline spiraling)
    // is bounded instead of burning unbounded cost. Raise if a real N=1000
    // run legitimately needs more.
    testTimeout: 1_800_000,
    hookTimeout: 600_000,
    teardownTimeout: 600_000,
    include: ["**/*.test.ts"],
    setupFiles: ["@deepagents/evals/setup"],
    reporters: ["langsmith/vitest/reporter"],
  },
});
