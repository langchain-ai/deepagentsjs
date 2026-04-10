import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 120_000,
  retries: 2,
  use: {
    baseURL: "http://localhost:4173",
  },
  webServer: {
    command: "npx vite --config e2e/fixture/vite.config.ts",
    port: 4173,
    reuseExistingServer: !process.env.CI,
  },
});
