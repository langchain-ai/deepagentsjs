import { defineConfig } from "tsdown";

// Mark only npm packages as external, excluding relative and absolute (Windows/Unix) paths
const external = (id: string) =>
  !id.startsWith(".") && !id.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(id);

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
