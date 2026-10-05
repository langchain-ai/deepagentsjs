/**
 * Minimal filesystem glob used by the local filesystem backends.
 *
 * Replaces `fast-glob`, whose `micromatch` -> `braces` dependency chain is
 * unmaintained and carries an unpatched DoS advisory (GHSA-vfj7-8cjw-p6xm).
 * Built on `fdir` (walking) and `picomatch` (matching), both dependency-free.
 *
 * It reproduces the subset of fast-glob behaviour the backends rely on with
 * `followSymbolicLinks: false`:
 * - Symlinked directories are never descended into, so self-referential links
 *   cannot loop and links cannot walk out of `cwd`.
 * - With `onlyFiles: true`, symlink entries are dropped entirely.
 * - With `onlyFiles: false`, symlink entries are reported (callers `stat()`
 *   them to re-include symlinks-to-files) and directories are included.
 * - Paths use `/` separators, directories have no trailing slash, and results
 *   are relative to `cwd` unless `absolute` is set. A leading `./` in the
 *   pattern is kept on relative results, and the static base directory of a
 *   dynamic pattern (`src` for `src/**`) is not itself returned.
 *
 * One deliberate difference: fast-glob follows symlinks that appear as
 * literal segments of a pattern (`link/*` lists the link target's contents,
 * even outside `cwd`). This helper never traverses a symlink.
 *
 * @module
 */

import path from "node:path";

import { fdir } from "fdir";
import picomatch from "picomatch";

export interface GlobOptions {
  /** Directory to search from. */
  cwd: string;
  /** Return absolute paths instead of paths relative to `cwd`. */
  absolute?: boolean;
  /** Only return regular files (drops directories and symlinks). */
  onlyFiles?: boolean;
  /** Match entries whose names start with a dot. */
  dot?: boolean;
}

const toPosix = (p: string) => p.split(path.sep).join("/");

/**
 * Number of directory levels a pattern can reach, or `undefined` when it is
 * unbounded (globstar, or braces that may hide extra `/` segments).
 */
function patternDepth(pattern: string): number | undefined {
  if (pattern.includes("**") || pattern.includes("{")) return undefined;
  return pattern.split("/").length - 1;
}

/**
 * Find filesystem entries under `cwd` matching `pattern`.
 */
export async function glob(
  pattern: string,
  options: GlobOptions,
): Promise<string[]> {
  const { cwd, absolute = false, onlyFiles = true, dot = false } = options;
  const normalizedPattern = pattern.replace(/^(\.\/)+/, "");
  const prefix = normalizedPattern === pattern ? "" : "./";

  const isMatch = picomatch(normalizedPattern, { dot });
  // Static leading directory of the pattern (e.g. `src/lib` for
  // `src/lib/**/*.ts`); directories that cannot lead to it are pruned.
  const { base, isGlob } = picomatch.scan(normalizedPattern);
  const root = path.resolve(cwd);

  const relativeDir = (dirPath: string) =>
    toPosix(path.relative(root, dirPath));

  const crawler = new fdir({
    relativePaths: true,
    pathSeparator: "/",
    includeDirs: !onlyFiles,
    excludeSymlinks: onlyFiles,
    maxDepth: patternDepth(normalizedPattern),
    exclude: (_dirName, dirPath) => {
      if (!base) return false;
      const rel = relativeDir(dirPath);
      return !(
        rel === base ||
        rel.startsWith(`${base}/`) ||
        base.startsWith(`${rel}/`)
      );
    },
    filters: [
      (entry) => {
        const rel = entry.endsWith("/") ? entry.slice(0, -1) : entry;
        if (rel === "" || rel === ".") return false;
        if (isGlob && rel === base) return false;
        return isMatch(rel);
      },
    ],
  });

  const entries = await crawler.crawl(root).withPromise();
  const rootPosix = toPosix(root);
  return entries.map((entry) => {
    const rel = entry.endsWith("/") ? entry.slice(0, -1) : entry;
    return absolute ? path.posix.join(rootPosix, rel) : prefix + rel;
  });
}
