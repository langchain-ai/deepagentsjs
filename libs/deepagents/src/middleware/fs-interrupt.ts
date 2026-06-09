/**
 * Glue between `FilesystemPermission` rules and `HumanInTheLoopMiddleware`.
 *
 * `FilesystemMiddleware` enforces deny rules and filters denied results only.
 * Graph assembly calls `buildInterruptOnFromPermissions` to turn filesystem
 * permissions into an `interruptOn` mapping with scope-aware `when` predicates.
 */

import type { InterruptOnConfig, ToolCallRequest } from "langchain";
import { validateFilePath } from "../backends/utils.js";
import { decidePathAccess } from "../permissions/enforce.js";
import type {
  FilesystemOperation,
  FilesystemPermission,
} from "../permissions/types.js";
import {
  globAnchor,
  pathsOverlap,
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

function bulkPatternFires(
  rawPattern: string,
  interruptAnchors: readonly string[],
): boolean {
  const posixPattern = toPosixPath(rawPattern);
  if (posixPattern.startsWith("/")) {
    const anchor = globAnchor(rawPattern);
    return interruptAnchors.some((ruleAnchor) =>
      pathsOverlap(anchor, ruleAnchor),
    );
  }

  return posixPattern.split("/").includes("..");
}

function makeBulkWhenPredicate(
  rules: readonly FilesystemPermission[],
  operation: FilesystemOperation,
  pathArgName: string,
  patternArgName: string | null,
): (request: ToolCallRequest) => boolean {
  const interruptAnchors = rules.flatMap((rule) =>
    rule.mode === "interrupt" && rule.operations.includes(operation)
      ? rule.paths.map((pattern) => globAnchor(pattern))
      : [],
  );

  return (request) => {
    if (interruptAnchors.length === 0) {
      return false;
    }

    const args = request.toolCall.args ?? {};
    const rawPath = args[pathArgName];
    if (rawPath == null) {
      return true;
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

    if (
      interruptAnchors.some((anchor) => pathsOverlap(normalized, anchor))
    ) {
      return true;
    }

    if (patternArgName != null) {
      const rawPattern = args[patternArgName];
      if (
        typeof rawPattern === "string" &&
        bulkPatternFires(rawPattern, interruptAnchors)
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
  FS_TOOL_PATH_ARGS,
};
