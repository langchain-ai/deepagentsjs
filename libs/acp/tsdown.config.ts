import { defineConfig } from "tsdown";

// Mark all node_modules as external since this is a library
const external = [/^[^./]/];

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
