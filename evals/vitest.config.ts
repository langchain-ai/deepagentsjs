import path from "node:path";
import { defineConfig, type ViteUserConfigExport } from "vitest/config";
import dotenv from "dotenv";

dotenv.config({ path: path.resolve(__dirname, "../.env") });

export default defineConfig({
  test: {
    environment: "node",
    hideSkippedTests: true,
    globals: true,
    testTimeout: 100_000,
    hookTimeout: 100_000,
    teardownTimeout: 60_000,
    include: ["src/**/*.eval.test.ts"],
  },
} satisfies ViteUserConfigExport);
