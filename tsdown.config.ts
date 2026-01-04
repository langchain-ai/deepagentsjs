import { defineConfig } from "tsdown";

export default defineConfig([{
  entry: ["./src/index.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: true,
  outDir: "dist",
  outExtensions: () => ({ js: '.js' }),
}, {
  entry: ["./src/index.ts"],
  format: ["cjs"],
  dts: true,
  clean: true,
  sourcemap: true,
  outDir: "dist",
  outExtensions: () => ({ js: '.cjs' }),
}]);
