import path from "node:path";
import { defineConfig } from "vitest/config";

const gatewaySetup = path.resolve(
  __dirname,
  "../../../scripts/vitest-setup-langsmith-gateway.ts",
);

export default defineConfig(({ mode }) => ({
  test: {
    globals: true,
    environment: "node",
    include: mode === "int" ? ["src/**/*.int.test.ts"] : ["src/**/*.test.ts"],
    exclude: mode === "int" ? [] : ["src/**/*.int.test.ts"],
    setupFiles: mode === "int" ? [gatewaySetup] : undefined,
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      exclude: [
        "node_modules/**",
        "dist/**",
        "**/*.test.ts",
        "**/*.int.test.ts",
        "tsdown.config.ts",
        "vitest.config.ts",
      ],
    },
  },
}));
