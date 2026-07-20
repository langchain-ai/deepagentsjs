import path from "node:path";
import {
  configDefaults,
  defineConfig,
  type ViteUserConfigExport,
} from "vitest/config";

const gatewaySetup = path.resolve(
  __dirname,
  "../../../scripts/vitest-setup-langsmith-gateway.ts",
);

export default defineConfig((env) => {
  const common: ViteUserConfigExport = {
    test: {
      environment: "node",
      hideSkippedTests: true,
      globals: true,
      testTimeout: 60_000,
      hookTimeout: 60_000,
      teardownTimeout: 60_000,
      exclude: ["**/*.int.test.ts", ...configDefaults.exclude],
    },
  };

  if (env.mode === "int") {
    return {
      test: {
        ...common.test,
        globals: false,
        testTimeout: 100_000,
        hookTimeout: 120_000,
        teardownTimeout: 120_000,
        exclude: configDefaults.exclude,
        include: ["**/*.int.test.ts"],
        name: "int",
        sequence: { concurrent: false },
        setupFiles: [gatewaySetup],
      },
    } satisfies ViteUserConfigExport;
  }

  return {
    test: {
      ...common.test,
      include: ["src/**/*.test.ts"],
    },
  } satisfies ViteUserConfigExport;
});
