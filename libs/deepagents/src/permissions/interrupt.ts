import { decidePathAccess, validatePath } from "./enforce.js";
import type { FilesystemOperation, FilesystemPermission } from "./types.js";

/**
 * Scope of a filesystem tool's path argument.
 *
 * - `"exact"`: the call operates on exactly the named path (`read_file`,
 *   `write_file`, `edit_file`). The interrupt fires iff that path matches an
 *   interrupt-mode rule.
 * - `"bulk"`: the path argument names a search root and the call may surface
 *   any descendant (`ls`, `glob`, `grep`). The interrupt fires whenever the
 *   search subtree could intersect an interrupt-mode rule, and — when the path
 *   argument is omitted — fires for any interrupt-mode rule on the operation
 *   because a pathless bulk call can touch anything.
 */
type ToolScope = "exact" | "bulk";

interface FsToolPathArg {
  operation: FilesystemOperation;
  pathArg: string;
  scope: ToolScope;
  /** Set only for `glob`, whose `pattern` can redirect the search root. */
  patternArg?: string;
}

/**
 * Maps each filesystem tool to the metadata its interrupt predicate needs.
 * Mirrors the filesystem tool input schemas defined in `middleware/fs.ts`.
 */
const FS_TOOL_PATH_ARGS: Record<string, FsToolPathArg> = {
  ls: { operation: "read", pathArg: "path", scope: "bulk" },
  read_file: { operation: "read", pathArg: "file_path", scope: "exact" },
  write_file: { operation: "write", pathArg: "file_path", scope: "exact" },
  edit_file: { operation: "write", pathArg: "file_path", scope: "exact" },
  glob: {
    operation: "read",
    pathArg: "path",
    scope: "bulk",
    patternArg: "pattern",
  },
  grep: { operation: "read", pathArg: "path", scope: "bulk" },
};

const GLOB_WILDCARD_CHARS = new Set(["*", "?", "[", "{"]);

/** Normalize backslash separators to forward slashes. */
function toPosixPath(path: string): string {
  return path.replace(/\\/g, "/");
}

function splitSegments(path: string): string[] {
  return toPosixPath(path)
    .split("/")
    .filter((s) => s.length > 0);
}

/**
 * Return the longest leading directory of `pattern` with no wildcards.
 *
 * For `/secrets/**` returns `/secrets`; for `/a/*\/b` returns `/a`; for a
 * pattern with a wildcard at or near the root (`/**\/secrets`, `/*\/foo`)
 * falls back to `/`. The root fallback makes overlap checks match any subtree
 * — conservative over-gating, since we cannot statically pin where the rule
 * resolves.
 */
export function globAnchor(pattern: string): string {
  const posix = toPosixPath(pattern);
  const isAbsolute = posix.startsWith("/");
  const safe: string[] = [];
  for (const segment of splitSegments(posix)) {
    if ([...segment].some((c) => GLOB_WILDCARD_CHARS.has(c))) {
      break;
    }
    safe.push(segment);
  }
  if (safe.length === 0) {
    return "/";
  }
  return (isAbsolute ? "/" : "") + safe.join("/");
}

/**
 * Return true if the subtree at `callPath` intersects the subtree at
 * `ruleAnchor`. Two subtrees overlap when one is a component-wise prefix of
 * the other (or they're equal). The root `/` overlaps everything; `/secret`
 * does not overlap `/secrets`.
 */
export function pathsOverlap(callPath: string, ruleAnchor: string): boolean {
  const a = splitSegments(callPath);
  const b = splitSegments(ruleAnchor);
  const shared = Math.min(a.length, b.length);
  for (let i = 0; i < shared; i += 1) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

/**
 * Whether a glob `pattern` reaches an interrupt-mode subtree regardless of the
 * call's `path`. An absolute pattern is matched from its own root, so gate on
 * the pattern's anchor. A relative pattern containing `..` can climb out of
 * `path`, so treat it as firing.
 */
function bulkPatternFires(
  rawPattern: string,
  interruptAnchors: string[],
): boolean {
  const posix = toPosixPath(rawPattern);
  if (posix.startsWith("/")) {
    const anchor = globAnchor(rawPattern);
    return interruptAnchors.some((a) => pathsOverlap(anchor, a));
  }
  return splitSegments(posix).includes("..");
}

type WhenPredicate = (args: Record<string, unknown>) => boolean;

function makeExactWhenPredicate(
  rules: readonly FilesystemPermission[],
  operation: FilesystemOperation,
  pathArg: string,
): WhenPredicate {
  return (args) => {
    const raw = args[pathArg];
    if (typeof raw !== "string") {
      return false;
    }
    let normalized: string;
    try {
      normalized = validatePath(raw);
    } catch {
      return false;
    }
    return decidePathAccess(rules, operation, normalized) === "interrupt";
  };
}

function makeBulkWhenPredicate(
  rules: readonly FilesystemPermission[],
  operation: FilesystemOperation,
  pathArg: string,
  patternArg: string | undefined,
): WhenPredicate {
  const interruptAnchors: string[] = [];
  for (const rule of rules) {
    if (rule.mode !== "interrupt" || !rule.operations.includes(operation)) {
      continue;
    }
    for (const pattern of rule.paths) {
      interruptAnchors.push(globAnchor(pattern));
    }
  }

  return (args) => {
    if (interruptAnchors.length === 0) {
      return false;
    }
    const raw = args[pathArg];
    let normalized: string;
    if (typeof raw !== "string") {
      // A missing path (e.g. bulk tools default to `/`) can't be localized,
      // so fire; any other non-string is malformed, so don't.
      if (raw === undefined || raw === null) {
        normalized = "/";
      } else {
        return false;
      }
    } else {
      try {
        normalized = validatePath(raw);
      } catch {
        return false;
      }
    }
    if (interruptAnchors.some((anchor) => pathsOverlap(normalized, anchor))) {
      return true;
    }
    if (patternArg !== undefined) {
      const rawPattern = args[patternArg];
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

/**
 * Build per-tool predicates that decide whether a filesystem tool call should
 * pause for human approval under interrupt-mode permission rules.
 *
 * Returns an entry for each filesystem tool whose operation is governed by at
 * least one interrupt-mode rule. Tools named in `excludeTools` (e.g. tools the
 * caller already routes through `interruptOn`) are skipped so the user-supplied
 * configuration wins.
 */
export function buildFsInterruptPredicates(
  rules: readonly FilesystemPermission[],
  excludeTools: ReadonlySet<string> = new Set(),
): Record<string, WhenPredicate> {
  const predicates: Record<string, WhenPredicate> = {};
  if (!rules.some((rule) => rule.mode === "interrupt")) {
    return predicates;
  }

  for (const [toolName, meta] of Object.entries(FS_TOOL_PATH_ARGS)) {
    if (excludeTools.has(toolName)) {
      continue;
    }
    const applies = rules.some(
      (rule) =>
        rule.mode === "interrupt" && rule.operations.includes(meta.operation),
    );
    if (!applies) {
      continue;
    }
    predicates[toolName] =
      meta.scope === "exact"
        ? makeExactWhenPredicate(rules, meta.operation, meta.pathArg)
        : makeBulkWhenPredicate(
            rules,
            meta.operation,
            meta.pathArg,
            meta.patternArg,
          );
  }

  return predicates;
}

/** Whether any rule requests interrupt-mode human approval. */
export function hasInterruptPermission(
  rules: readonly FilesystemPermission[],
): boolean {
  return rules.some((rule) => rule.mode === "interrupt");
}
