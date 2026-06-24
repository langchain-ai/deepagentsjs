import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

import { createLangGraphViteProxy } from "./scripts/vite-langgraph-proxy.js";

export default defineConfig({
  plugins: [react()],
  // Expose `LANGSMITH_*` env vars (not just `VITE_*`) to the client so a single
  // LANGSMITH_API_KEY serves both `langgraphjs deploy` and the browser client.
  envPrefix: ["VITE_", "LANGSMITH_"],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
  server: {
    proxy: createLangGraphViteProxy(),
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
