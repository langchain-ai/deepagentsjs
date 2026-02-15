import { defineConfig } from 'rollup'
import terser from "@rollup/plugin-terser";
import pkg from "./package.json" with { type: "json" };
import dts from "rollup-plugin-dts";
// import typescript from "@rollup/plugin-typescript";
import typescript from "rollup-plugin-typescript2";
import replace from "@rollup/plugin-replace";
import copy from "rollup-plugin-copy";
import { wasm } from "@rollup/plugin-wasm";
import fs from "fs";

const LIBRARY_NAME = "WasmerSDK"; // Change with your library's name
const EXTERNAL = [
  "deepagents",
  "web-worker",
  /^node:/,
]; // Indicate which modules should be treated as external
const GLOBALS = {}; // https://rollupjs.org/guide/en/#outputglobals

const entries = [
  'src/index.ts',
  'src/node.ts',
  'src/worker.js',
]

const banner = `/*!
 * ${pkg.name}
 * ${pkg.description}
 *
 * @version v${pkg.version}
 * @author ${pkg.author}
 * @license ${pkg.license}
 */`;

const makeConfig = (env = "development", plugins = []) => {
  const config = {
    input: entries,
    external: EXTERNAL,
    output: {
        banner,
        dir: 'dist',
        format: 'esm',
        entryFileNames: '[name].mjs',
      },
    plugins: [
      typescript({
        // rootDir: "./src",
      }),
      wasmPlugin(),
      // wasm({
      //   maxFileSize: 100 * 1024 * 1024,
      // }),
      copy({
        targets: [
          {
            src: ["rust/runtime/pkg/deepbash_bg.wasm", "rust/runtime/pkg/deepbash_bg.wasm.d.ts"],
            dest: "dist",
          },
        ],
      }),
      replace({
        values: {
          "globalThis.wasmUrl": `"https://unpkg.com/${pkg.name}@${pkg.version}/dist/deepbash_bg.wasm"`,
          "globalThis.workerUrl": `"https://unpkg.com/${pkg.name}@${pkg.version}/dist/index.mjs"`,
        },
        preventAssignment: true,
      }),
      ...plugins,
    ],
    external: EXTERNAL,
  };
  const tsConfig = {
    input: entries,
    output: {
      dir: 'dist',
      format: 'esm',
      entryFileNames: f => `${f.name.replace(/src[\\/]/, '')}.d.mts`,
    },
    plugins: [
      dts({
        respectExternal: true,
      })
    ],
    external: EXTERNAL,
  };
  return [config, tsConfig];
};

export default commandLineArgs => {
  let env =
    commandLineArgs.environment === "BUILD:production" ? "production" : null;
    let plugins = [];
    if (env === "production") {
      plugins.push(
        terser({
          output: {
            comments: /^!/,
          },
        }),
      );
    }

  const configs = makeConfig(env, plugins);

  return configs;
};

/**
 * @returns {import('rollup').Plugin} Plugin
 */
export function wasmPlugin() {
  return {
    name: 'wasm',
    async load(id) {
      if (!id.endsWith('.wasm'))
        return
      const binary = await fs.readFileSync(id)
      const base64 = binary.toString('base64')
      return `
var isNode = typeof process !== 'undefined' && process.versions != null && process.versions.node != null;
const src = ${JSON.stringify(base64)};

if (isNode) {
  buf = Buffer.from(src, 'base64');
}
else {
  buf = Uint8Array.from(atob(src), c => c.charCodeAt(0));
}
export default buf;
`
    },
  }
}
