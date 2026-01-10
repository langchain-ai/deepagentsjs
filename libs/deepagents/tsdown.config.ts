import { defineConfig } from "tsdown";

export default defineConfig([
  {
    entry: ["./src/index.ts"],
    format: ["esm"],
    dts: true,
    clean: true,
    sourcemap: true,
    outDir: "dist",
    outExtensions: () => ({ js: ".js" }),
    // Externalize @langchain/core to prevent bundling duplicate copies.
    // This fixes instanceof checks (e.g. AIMessageChunk) failing when
    // providers like Ollama construct chunks from a different module instance.
    external: [/^@langchain\/core/],
  },
  {
    entry: ["./src/index.ts"],
    format: ["cjs"],
    dts: true,
    clean: true,
    sourcemap: true,
    outDir: "dist",
    outExtensions: () => ({ js: ".cjs" }),
    // Externalize @langchain/core to prevent bundling duplicate copies.
    external: [/^@langchain\/core/],
  },
]);
