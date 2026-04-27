import micromatch from "micromatch";
import type {
  FilesystemOperation,
  FilesystemPermission,
  PermissionMode,
} from "./types.js";

/**
 * Canonicalize a path before matching against permission rules.
 *
 * Rejects:
 * - Non-absolute paths (must start with `/`)
 * - Paths containing `..`
 * - Paths containing `~`
 *
 * Throws on invalid input. Callers should catch and skip the check,
 * deferring to the tool's own validation.
 *
 * @internal
 */
export function validatePath(raw: string): string {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new Error("path must be a non-empty string");
  }

  if (!raw.startsWith("/")) {
    throw new Error(`path must be absolute: ${JSON.stringify(raw)}`);
  }

  const parts = raw.split("/").filter((p) => p.length > 0);
  if (parts.includes("..")) {
    throw new Error(`path must not contain '..': ${JSON.stringify(raw)}`);
  }

  if (parts.includes("~")) {
    throw new Error(`path must not contain '~': ${JSON.stringify(raw)}`);
  }

  return `/${parts.join("/")}`;
}

/**
 * Match `path` against a glob `pattern`.
 *
 * Supports `**` (any number of directory levels), `*` (single segment),
 * and `{a,b}` (brace expansion). Dotfiles are matched.
 *
 * @internal
 */
export function globMatch(path: string, pattern: string): boolean {
  return micromatch.isMatch(path, pattern, { dot: true });
}

/**
 * Evaluate permission rules for a given operation and path.
 *
 * Rules are checked in order; the first rule whose `operations` includes the
 * requested operation and whose `paths` glob-matches the requested path
 * determines the outcome. If no rule matches, access is allowed (permissive default).
 *
 * @internal
 */
export function decidePathAccess(
  rules: FilesystemPermission[],
  operation: FilesystemOperation,
  path: string,
): PermissionMode {
  for (const rule of rules) {
    if (!rule.operations.includes(operation)) {
      continue;
    }

    if (rule.paths.some((pattern) => globMatch(path, pattern))) {
      return rule.mode;
    }
  }

  return "allow";
}
