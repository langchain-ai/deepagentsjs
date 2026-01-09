import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["./src/index.ts", "./src/cli.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: true,
  outDir: "dist",
  outExtensions: () => ({ js: ".js" }),
  // Ensure shebang is preserved for CLI
  esbuildOptions: {
    banner: {
      js: "",
    },
  },
});
