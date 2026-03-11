import {
  configDefaults,
  defineConfig,
  type ViteUserConfigExport,
} from "vitest/config";

export default defineConfig((env) => {
  const common: ViteUserConfigExport = {
    test: {
      environment: "node",
      testTimeout: 30_000,
      hookTimeout: 30_000,
      exclude: ["**/*.int.test.ts", ...configDefaults.exclude],
    },
  };

  if (env.mode === "int") {
    return {
      test: {
        ...common.test,
        testTimeout: 60_000,
        exclude: configDefaults.exclude,
        include: ["src/**/*.int.test.ts"],
        name: "int",
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
