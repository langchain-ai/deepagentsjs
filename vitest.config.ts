import { defineConfig } from "vitest/config";
import { config } from "dotenv";

config();

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts"],
    exclude: ["node_modules", "dist"],
    testTimeout: 60000, // 60 seconds for integration tests
    hookTimeout: 60000,
    teardownTimeout: 60000,
  },
});
