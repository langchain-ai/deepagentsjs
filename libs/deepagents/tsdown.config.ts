import { defineConfig } from "tsdown";
import { version } from "./package.json"  with { type: "json" };

// Mark all node_modules as external since this is a library
const external = [/^[^./]/];

const { version } = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf-8"),
);

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
    define: {
      __SDK_VERSION__: JSON.stringify(version),
    },
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
    define: {
      __SDK_VERSION__: JSON.stringify(version),
    },
  },
]);
