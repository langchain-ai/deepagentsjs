import { defineConfig } from "tsdown";

const external = [/^[^./]/];

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
    clean: true,
    sourcemap: true,
    outDir: "dist",
    outExtensions: () => ({ js: ".cjs" }),
    external,
  },
]);
