import { defineConfig } from "tsdown";

// Mark only npm packages as external, excluding relative and absolute (Windows/Unix) paths
const external = (id: string) =>
  !id.startsWith(".") && !id.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(id);

export default defineConfig([
  // Library builds (ESM + CJS)
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
  // CLI build (ESM only, executable)
  {
    entry: ["./src/cli.ts"],
    format: ["esm"],
    dts: false,
    clean: false, // Don't clean to preserve other builds
    sourcemap: true,
    outDir: "dist",
    outExtensions: () => ({ js: ".js" }),
    external,
    // Add shebang for executable
    banner: {
      js: "#!/usr/bin/env node",
    },
  },
]);
