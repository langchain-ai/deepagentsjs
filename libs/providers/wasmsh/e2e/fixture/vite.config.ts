import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import sirv from "sirv";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// wasmsh-pyodide npm package (resolved from node_modules)
const wasmshPkgDir = dirname(
  require.resolve("@mayflowergmbh/wasmsh-pyodide/package.json"),
);
const assetsDir = resolve(wasmshPkgDir, "assets");

// langchain full entry (browser entry omits agent middleware)
const langchainDir = dirname(require.resolve("langchain/package.json"));

/**
 * Serve wasmsh Pyodide assets and browser-worker.js as static files.
 */
function wasmshAssetsPlugin(): Plugin {
  return {
    name: "wasmsh-assets",
    configureServer(server) {
      // Pyodide dist assets at /assets/
      server.middlewares.use("/assets", sirv(assetsDir, { dev: true }));
      // browser-worker.js at /worker/
      server.middlewares.use("/worker", sirv(wasmshPkgDir, { dev: true }));
    },
  };
}

export default defineConfig({
  root: __dirname,
  plugins: [wasmshAssetsPlugin()],
  resolve: {
    alias: [
      // langchain's "browser" export omits agent middleware (createAgent, etc.).
      // Force the full entry so deepagents' imports resolve correctly.
      {
        find: /^langchain$/,
        replacement: resolve(langchainDir, "dist/index.js"),
      },
      {
        find: /^langchain\/(.+)/,
        replacement: resolve(langchainDir, "dist/$1"),
      },
      // node:async_hooks polyfill for LangGraph (uses AsyncLocalStorage)
      {
        find: /^node:async_hooks$/,
        replacement: resolve(__dirname, "shims/async-hooks.ts"),
      },
      // path polyfill for micromatch (used by backend utils)
      {
        find: /^(node:)?path$/,
        replacement: "path-browserify",
      },
    ],
  },
  define: {
    "process.platform": JSON.stringify("browser"),
    "process.env": JSON.stringify({}),
  },
  server: {
    port: 4173,
    strictPort: true,
  },
});
