const GLOB_WILDCARD_CHARS = new Set(["*", "?", "[", "{"]);

/**
 * Normalize backslash separators to forward slashes for POSIX path logic.
 */
export function toPosixPath(path: string): string {
  return path.replace(/\\/g, "/");
}

/**
 * Return the longest leading directory of `pattern` with no wildcards.
 *
 * For `/secrets/**` returns `/secrets`; for patterns with a leading globstar
 * falls back to `/`.
 */
export function globAnchor(pattern: string): string {
  const parts = toPosixPath(pattern)
    .split("/")
    .filter((part) => part.length > 0);

  const safe: string[] = [];
  for (const part of parts) {
    if ([...part].some((char) => GLOB_WILDCARD_CHARS.has(char))) {
      break;
    }
    safe.push(part);
  }

  if (safe.length === 0) {
    return "/";
  }

  return `/${safe.join("/")}`;
}

function pathComponents(path: string): string[] {
  const trimmed = toPosixPath(path).replace(/\/+$/, "");
  if (!trimmed || trimmed === "/") {
    return [];
  }

  return trimmed.split("/").filter((part) => part.length > 0);
}

/**
 * Return true when the subtree at `callPath` intersects `ruleAnchor`.
 *
 * Component-wise prefix check: `/secret` does not overlap `/secrets`.
 * Root `/` overlaps everything.
 */
export function pathsOverlap(callPath: string, ruleAnchor: string): boolean {
  const a = pathComponents(callPath);
  const b = pathComponents(ruleAnchor);

  if (a.length === 0 || b.length === 0) {
    return true;
  }

  const aKey = a.join("/");
  const bKey = b.join("/");
  if (aKey === bKey) {
    return true;
  }

  return aKey.startsWith(`${bKey}/`) || bKey.startsWith(`${aKey}/`);
}
