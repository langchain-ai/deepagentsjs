/**
 * Glue between `FilesystemPermission` rules and `HumanInTheLoopMiddleware`.
 *
 * `FilesystemMiddleware` enforces deny rules and filters denied results only.
 * Graph assembly calls `buildInterruptOnFromPermissions` to turn filesystem
 * permissions into an `interruptOn` mapping with scope-aware `when` predicates.
 */

import type { InterruptOnConfig, ToolCallRequest } from "langchain";
import { validateFilePath } from "../backends/utils.js";
import { decidePathAccess, globMatch } from "../permissions/enforce.js";
import type {
  FilesystemOperation,
  FilesystemPermission,
} from "../permissions/types.js";
import {
  globAnchor,
  pathsOverlap,
  stripTrailingSlashes,
  toPosixPath,
} from "../permissions/path-utils.js";

type ToolScope = "exact" | "bulk";

const FS_TOOL_PATH_ARGS: Record<
  string,
  readonly [FilesystemOperation, string, ToolScope, string | null]
> = {
  ls: ["read", "path", "bulk", null],
  read_file: ["read", "file_path", "exact", null],
  write_file: ["write", "file_path", "exact", null],
  edit_file: ["write", "file_path", "exact", null],
  glob: ["read", "path", "bulk", "pattern"],
  grep: ["read", "path", "bulk", null],
};

const FULL_HITL_DECISIONS = ["approve", "edit", "reject"] as const;

function makeExactWhenPredicate(
  rules: readonly FilesystemPermission[],
  operation: FilesystemOperation,
  pathArgName: string,
): (request: ToolCallRequest) => boolean {
  return (request) => {
    const rawPath = request.toolCall.args?.[pathArgName];
    if (typeof rawPath !== "string") {
      return false;
    }

    try {
      const normalized = validateFilePath(rawPath);
      return decidePathAccess(rules, operation, normalized) === "interrupt";
    } catch {
      return false;
    }
  };
}

/**
 * Build a probe path inside `callPath`'s subtree that could match `rulePattern`.
 *
 * Used with `decidePathAccess` so bulk interrupts honor first-match-wins.
 */
function representativeProbePath(callPath: string, rulePattern: string): string {
  const anchor = globAnchor(rulePattern);
  const call = stripTrailingSlashes(callPath) || "/";

  if (call === "/") {
    if (rulePattern.includes("**")) {
      return anchor === "/" ? "/__hitl_probe__" : `${anchor}/__hitl_probe__`;
    }
    return anchor;
  }

  const childProbe = `${call}/__hitl_probe__`;
  if (globMatch(childProbe, rulePattern)) {
    return childProbe;
  }
  if (globMatch(call, rulePattern)) {
    return call;
  }

  if (pathsOverlap(call, anchor)) {
    if (rulePattern.includes("**")) {
      const base =
        call === anchor || anchor.startsWith(`${call}/`) ? anchor : call;
      return base === "/" ? "/__hitl_probe__" : `${base}/__hitl_probe__`;
    }
    return anchor;
  }

  return anchor === "/" ? "/__hitl_probe__" : `${anchor}/__hitl_probe__`;
}

/**
 * Return true when a bulk call rooted at `callPath` could surface paths that
 * resolve to interrupt under first-match-wins rule ordering.
 */
function bulkSubtreeCouldInterrupt(
  rules: readonly FilesystemPermission[],
  operation: FilesystemOperation,
  callPath: string,
): boolean {
  for (const rule of rules) {
    if (rule.mode !== "interrupt" || !rule.operations.includes(operation)) {
      continue;
    }

    for (const pattern of rule.paths) {
      const anchor = globAnchor(pattern);
      if (!pathsOverlap(callPath, anchor)) {
        continue;
      }

      const probePath = representativeProbePath(callPath, pattern);
      if (decidePathAccess(rules, operation, probePath) === "interrupt") {
        return true;
      }
    }
  }

  return false;
}

function bulkPatternCouldInterrupt(
  rules: readonly FilesystemPermission[],
  operation: FilesystemOperation,
  normalizedPath: string,
  rawPattern: string,
): boolean {
  const posixPattern = toPosixPath(rawPattern);
  if (posixPattern.startsWith("/")) {
    return bulkSubtreeCouldInterrupt(
      rules,
      operation,
      globAnchor(rawPattern),
    );
  }

  if (posixPattern.split("/").includes("..")) {
    return rules.some(
      (rule) =>
        rule.mode === "interrupt" && rule.operations.includes(operation),
    );
  }

  return bulkSubtreeCouldInterrupt(rules, operation, normalizedPath);
}

function hasInterruptRules(
  rules: readonly FilesystemPermission[],
  operation: FilesystemOperation,
): boolean {
  return rules.some(
    (rule) =>
      rule.mode === "interrupt" && rule.operations.includes(operation),
  );
}

function makeBulkWhenPredicate(
  rules: readonly FilesystemPermission[],
  operation: FilesystemOperation,
  pathArgName: string,
  patternArgName: string | null,
): (request: ToolCallRequest) => boolean {
  return (request) => {
    if (!hasInterruptRules(rules, operation)) {
      return false;
    }

    const args = request.toolCall.args ?? {};
    const rawPath = args[pathArgName];
    if (rawPath == null) {
      return bulkSubtreeCouldInterrupt(rules, operation, "/");
    }
    if (typeof rawPath !== "string") {
      return false;
    }

    let normalized: string;
    try {
      normalized = validateFilePath(rawPath);
    } catch {
      return false;
    }

    if (normalized === "/.") {
      normalized = "/";
    }

    if (bulkSubtreeCouldInterrupt(rules, operation, normalized)) {
      return true;
    }

    if (patternArgName != null) {
      const rawPattern = args[patternArgName];
      if (
        typeof rawPattern === "string" &&
        bulkPatternCouldInterrupt(rules, operation, normalized, rawPattern)
      ) {
        return true;
      }
    }

    return false;
  };
}

function makeFsWhenPredicate(
  rules: readonly FilesystemPermission[],
  operation: FilesystemOperation,
  pathArgName: string,
  scope: ToolScope,
  patternArgName: string | null = null,
): (request: ToolCallRequest) => boolean {
  if (scope === "exact") {
    return makeExactWhenPredicate(rules, operation, pathArgName);
  }

  return makeBulkWhenPredicate(
    rules,
    operation,
    pathArgName,
    patternArgName,
  );
}

/**
 * Generate `interruptOn` configs from interrupt-mode filesystem permissions.
 */
export function buildInterruptOnFromPermissions(
  rules: readonly FilesystemPermission[],
): Record<string, InterruptOnConfig> {
  if (!rules.some((rule) => rule.mode === "interrupt")) {
    return {};
  }

  const result: Record<string, InterruptOnConfig> = {};
  for (const [toolName, [operation, pathArg, scope, patternArg]] of Object.entries(
    FS_TOOL_PATH_ARGS,
  )) {
    if (
      !rules.some(
        (rule) => rule.mode === "interrupt" && rule.operations.includes(operation),
      )
    ) {
      continue;
    }

    result[toolName] = {
      allowedDecisions: [...FULL_HITL_DECISIONS],
      when: makeFsWhenPredicate(rules, operation, pathArg, scope, patternArg),
    };
  }

  return result;
}

/**
 * Merge fs-permission-derived configs with user-supplied `interruptOn`.
 *
 * User-supplied entries override generated ones per tool name. Returns
 * `undefined` when both inputs are empty so callers can skip HITL middleware.
 */
export function mergeFsInterruptOn(
  fsInterruptOn: Record<string, InterruptOnConfig>,
  userInterruptOn?: Record<string, boolean | InterruptOnConfig> | null,
): Record<string, boolean | InterruptOnConfig> | undefined {
  if (
    Object.keys(fsInterruptOn).length === 0 &&
    (!userInterruptOn || Object.keys(userInterruptOn).length === 0)
  ) {
    return undefined;
  }

  return {
    ...fsInterruptOn,
    ...(userInterruptOn ?? {}),
  };
}

/** @internal Exported for unit tests. */
export const _testExports = {
  makeFsWhenPredicate,
  bulkSubtreeCouldInterrupt,
  FS_TOOL_PATH_ARGS,
};
