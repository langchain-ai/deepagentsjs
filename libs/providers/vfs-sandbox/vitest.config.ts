import { defineConfig } from "vitest/config";

export default defineConfig(({ mode }) => ({
  test: {
    globals: true,
    environment: "node",
    include:
      mode === "int"
        ? ["src/**/*.int.test.ts"]
        : ["src/**/*.test.ts"],
    exclude:
      mode === "int"
        ? []
        : ["src/**/*.int.test.ts"],
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
