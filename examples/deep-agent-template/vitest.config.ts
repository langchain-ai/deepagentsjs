import {
  configDefaults,
  defineConfig,
  ViteUserConfigExport,
} from "vitest/config";

export default defineConfig((env) => {
  // Shared settings applied to all test modes.
  const common: ViteUserConfigExport = {
    test: {
      environment: "node",
      globals: true,
      testTimeout: 60_000,
      hookTimeout: 60_000,
      teardownTimeout: 60_000,
      // Register LangChain custom matchers (toBeAIMessage, toContainToolCall, etc.)
      // before every suite.
      setupFiles: ["./vitest.setup.ts"],
      // By default, exclude integration and eval tests — those run in
      // dedicated modes below.
      exclude: [
        "**/*.int.test.ts",
        "**/*.eval.test.ts",
        ...configDefaults.exclude,
      ],
    },
  };

  // `vitest run --mode int` — integration tests only.
  // Requires provider API keys (e.g. ANTHROPIC_API_KEY).
  if (env.mode === "int") {
    return {
      test: {
        ...common.test,
        globals: false,
        testTimeout: 100_000,
        exclude: configDefaults.exclude,
        include: ["**/*.int.test.ts"],
        name: "int",
      },
    };
  }

  // `vitest run --mode eval` — evaluation tests with LangSmith reporting.
  if (env.mode === "eval") {
    return {
      test: {
        ...common.test,
        globals: false,
        testTimeout: 120_000,
        exclude: configDefaults.exclude,
        include: ["**/*.eval.test.ts"],
        reporters: ["langsmith/vitest/reporter"],
        name: "eval",
      },
    };
  }

  // Default: unit tests only
  return {
    test: {
      ...common.test,
      include: ["src/**/*.test.ts"],
    },
  };
});
