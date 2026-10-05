/**
 * Resource limits for glob patterns.
 *
 * Glob patterns reach `picomatch` from tool-call arguments, i.e. from the
 * model. picomatch compiles each pattern to a RegExp and accepts patterns up
 * to 65,536 characters; a few thousand levels of nested `{a,{a,...}}` or
 * `@(a|@(a|...))` exhaust V8's regex compiler and abort the process with an
 * out-of-memory error that cannot be caught. Real-world globs are short and
 * shallow, so patterns beyond these limits are rejected before compiling.
 *
 * This module has no Node.js dependencies so it can be shared by every
 * backend, the filesystem middleware, and permission rules.
 *
 * @module
 */

import picomatch from "picomatch";

/** Maximum accepted glob pattern length, in characters. */
export const MAX_GLOB_PATTERN_LENGTH = 1024;

/** Maximum nesting depth of `{...}` and `(...)` groups in a glob pattern. */
export const MAX_GLOB_NESTING_DEPTH = 32;

/**
 * Check a glob pattern against the resource limits.
 *
 * @returns An error message if the pattern is rejected, otherwise `undefined`.
 */
export function validateGlobPattern(pattern: string): string | undefined {
  if (pattern.length > MAX_GLOB_PATTERN_LENGTH) {
    return `Glob pattern is too long (${pattern.length} characters, max ${MAX_GLOB_PATTERN_LENGTH})`;
  }

  let depth = 0;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "\\") {
      i++;
    } else if (ch === "{" || ch === "(") {
      depth++;
      if (depth > MAX_GLOB_NESTING_DEPTH) {
        return `Glob pattern nests braces or parentheses too deeply (max ${MAX_GLOB_NESTING_DEPTH} levels)`;
      }
    } else if ((ch === "}" || ch === ")") && depth > 0) {
      depth--;
    }
  }
  return undefined;
}

/**
 * `picomatch.isMatch` that never compiles a pattern exceeding the limits;
 * such patterns match nothing.
 */
export function isGlobMatch(
  str: string,
  pattern: string,
  options?: picomatch.PicomatchOptions,
): boolean {
  if (validateGlobPattern(pattern) !== undefined) return false;
  return picomatch.isMatch(str, pattern, options);
}
