import { defineConfig } from "tsdown";

export default defineConfig([
  {
    entry: ["./src/index.ts"],
    format: ["esm"],
    dts: true,
    clean: true,
    sourcemap: true,
    outDir: "dist",
    // Add shebang for executable
    banner: {
      js: "#!/usr/bin/env node",
    },
  },
]);
