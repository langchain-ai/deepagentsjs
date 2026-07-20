import path from "node:path";
import {
  configDefaults,
  defineConfig,
  type ViteUserConfigExport,
} from "vitest/config";
import { configureLangSmithGateway } from "../../scripts/vitest-setup-langsmith-gateway.js";

// Side-effect import already loads root .env + gateway; call again is idempotent.
configureLangSmithGateway();

const gatewaySetup = path.resolve(
  __dirname,
  "../../scripts/vitest-setup-langsmith-gateway.ts",
);

export default defineConfig((env) => {
  const common: ViteUserConfigExport = {
    test: {
      environment: "node",
      testTimeout: 30_000,
      hookTimeout: 30_000,
      exclude: ["**/*.int.test.ts", ...configDefaults.exclude],
      coverage: {
        provider: "v8",
        reporter: ["text", "json", "html"],
      },
    },
  };

  // Integration tests mode: vitest --mode int
  if (env.mode === "int") {
    return {
      test: {
        ...common.test,
        testTimeout: 60_000,
        exclude: configDefaults.exclude,
        include: ["src/**/*.int.test.ts"],
        name: "int",
        setupFiles: [gatewaySetup],
      },
    } satisfies ViteUserConfigExport;
  }

  // All tests mode: vitest --mode all
  if (env.mode === "all") {
    return {
      test: {
        ...common.test,
        testTimeout: 60_000,
        exclude: configDefaults.exclude,
        include: ["src/**/*.test.ts", "src/**/*.int.test.ts"],
        name: "all",
        setupFiles: [gatewaySetup],
      },
    } satisfies ViteUserConfigExport;
  }

  // Default: unit tests only
  return {
    test: {
      ...common.test,
      include: ["src/**/*.test.ts"],
    },
  } satisfies ViteUserConfigExport;
});
