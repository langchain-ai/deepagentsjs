import micromatch from "micromatch";
import type {
  FilesystemOperation,
  FilesystemPermission,
  PermissionMode,
} from "./types.js";

/**
 * Validate permission rule paths at setup time. Throws if any path is
 * relative, contains `..`, or contains `~`.
 */
export function validatePermissionPaths(
  permissions: FilesystemPermission[],
): void {
  for (const permission of permissions) {
    for (const path of permission.paths) {
      validatePath(path);
    }
  }
}

/**
 * Canonicalize and validate an absolute path before permission checking.
 *
 * Throws for:
 * - Empty or non-string input
 * - Non-absolute paths (must start with `/`)
 * - Paths containing `..`
 * - Paths containing `~`
 */
export function validatePath(raw: string): string {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new Error("path must be a non-empty string");
  }

  if (!raw.startsWith("/")) {
    throw new Error(`path must be absolute: ${JSON.stringify(raw)}`);
  }

  const segments = raw.split("/").filter((s) => s.length > 0);
  if (segments.includes("..")) {
    throw new Error(`path must not contain "..": ${JSON.stringify(raw)}`);
  }

  if (segments.includes("~")) {
    throw new Error(`path must not contain "~": ${JSON.stringify(raw)}`);
  }

  return `/${segments.join("/")}`;
}

/**
 * Test whether `path` matches a glob `pattern`.
 *
 * Supports:
 * - `**` — any number of directory levels
 * - `*` — within a single path segment
 * - `{a,b}` — brace expansion
 *
 * Uses `micromatch` with `dot: true` so dotfiles are matched by default.
 */
export function globMatch(path: string, pattern: string): boolean {
  return micromatch.isMatch(path, pattern, { dot: true });
}

/**
 * Evaluate permission rules against an operation + path and return the
 * access decision.
 *
 * First-match-wins; permissive default.
 *
 * @returns `"allow"` if the operation is permitted, `"deny"` otherwise.
 */
export function decidePathAccess(
  rules: readonly FilesystemPermission[],
  operation: FilesystemOperation,
  path: string,
): PermissionMode {
  for (const rule of rules) {
    if (!rule.operations.includes(operation)) {
      continue;
    }

    if (rule.paths.some((pattern) => globMatch(path, pattern))) {
      return rule.mode ?? "allow";
    }
  }

  return "allow";
}
