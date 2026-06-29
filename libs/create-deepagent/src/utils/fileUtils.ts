import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Resolve the template directory for a framework.
 * Templates live in `registry/frameworks/{frameworkDir}/` relative to the
 * package root. When running from the bundled dist, `import.meta.url` is
 * `dist/index.js`, so we go up one level to reach the package root.
 */
export function resolveFrameworkDir(frameworkDir: string): string {
  const distDir = path.dirname(fileURLToPath(import.meta.url));
  const packageRoot = path.resolve(distDir, "..");
  return path.join(packageRoot, "registry", "frameworks", frameworkDir);
}

/**
 * Copy a directory recursively. Filters out `node_modules` for dev ergonomics
 */
export async function copyDir(src: string, dest: string): Promise<void> {
  await fs.promises.cp(src, dest, {
    recursive: true,
    filter: (source) => !source.includes("node_modules"),
  });
}

/** Loads a json file and asserts type. Performs no checks prior to read. */
export function loadJsonSync(filePath: string) {
  const raw = fs.readFileSync(filePath, "utf-8");
  return JSON.parse(raw);
}

/**
 * Write a file, creating parent directories as needed.
 */
export async function writeFile(
  filePath: string,
  content: string,
): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.promises.mkdir(dir, { recursive: true });
  await fs.promises.writeFile(filePath, content);
}
