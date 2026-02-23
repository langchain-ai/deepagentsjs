import path from "node:path";
import { configDefaults, defineConfig, type ViteUserConfigExport } from "vitest/config";
import dotenv from "dotenv";

dotenv.config({ path: path.resolve(__dirname, ".env") });

export default defineConfig((env) => {
  if (env.mode === "int") {
    return {
      test: {
        environment: "node",
        globals: false,
        testTimeout: 120_000,
        hookTimeout: 120_000,
        exclude: configDefaults.exclude,
        include: ["**/*.int.test.ts"],
        name: "int",
      },
    } satisfies ViteUserConfigExport;
  }

  if (env.mode === "eval") {
    return {
      test: {
        environment: "node",
        globals: false,
        testTimeout: 120_000,
        hookTimeout: 120_000,
        exclude: configDefaults.exclude,
        include: ["**/*.eval.ts"],
        reporters: ["langsmith/vitest/reporter"],
        name: "eval",
      },
    } satisfies ViteUserConfigExport;
  }

  return {
    test: {
      environment: "node",
      globals: true,
      testTimeout: 60_000,
      exclude: ["**/*.int.test.ts", "**/*.eval.ts", ...configDefaults.exclude],
    },
  } satisfies ViteUserConfigExport;
});
