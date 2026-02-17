import { defineConfig } from "tsdown";

// Mark all node_modules as external since this is a library
const external = [/^[^./]/];

export default defineConfig([
  {
    entry: ["./src/index.ts", "./src/runner.ts"],
    format: ["esm"],
    dts: true,
    clean: true,
    sourcemap: true,
    outDir: "dist",
    outExtensions: () => ({ js: ".js" }),
    external,
  },
  {
    entry: ["./src/index.ts", "./src/runner.ts"],
    format: ["cjs"],
    dts: true,
    clean: true,
    sourcemap: true,
    outDir: "dist",
    outExtensions: () => ({ js: ".cjs" }),
    external,
  },
]);
