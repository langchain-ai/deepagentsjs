import { defineConfig } from "tsdown";

// Mark all node_modules as external since this is a library
const external = [/^[^./]/];

// Browser build: inline `langchain` (its browser entry omits agent middleware)
// but keep @langchain/* external (they have proper browser support)
const browserExternal = [/^(?!langchain(\/|$))[^./]/];

export default defineConfig([
  {
    entry: ["./src/index.ts"],
    format: ["esm"],
    dts: true,
    clean: true,
    sourcemap: true,
    outDir: "dist",
    outExtensions: () => ({ js: ".js" }),
    external,
  },
  {
    entry: ["./src/index.ts"],
    format: ["cjs"],
    dts: true,
    clean: false,
    sourcemap: true,
    outDir: "dist",
    outExtensions: () => ({ js: ".cjs" }),
    external,
  },
  {
    entry: { "index.browser": "./src/index.browser.ts" },
    format: ["esm"],
    dts: true,
    clean: false,
    sourcemap: true,
    outDir: "dist",
    outExtensions: () => ({ js: ".js" }),
    external: browserExternal,
  },
]);
