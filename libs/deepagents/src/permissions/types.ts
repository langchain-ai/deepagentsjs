/**
 * The filesystem operations a permission rule can govern.
 */
export type FilesystemOperation = "read" | "write";

/**
 * Whether a matched rule permits, blocks, or pauses the operation for approval.
 */
export type PermissionMode = "allow" | "deny" | "interrupt";

/**
 * A single filesystem permission rule.
 *
 * Rules are evaluated in declaration order; the first rule whose
 * `operations` includes the requested operation AND whose `paths`
 * glob-matches the target path determines the outcome. If no rule
 * matches, access is **allowed** (permissive default).
 *
 * All `paths` must be absolute glob patterns (start with `/`, no `..` or `~`).
 * Supports `**` (any depth), `*` (within one segment), and `{a,b}` brace expansion.
 * Paths are validated when passed to {@link createFilesystemMiddleware}.
 */
export interface FilesystemPermission {
  /**
   * The operations this rule applies to.
   */
  operations: readonly FilesystemOperation[];

  /**
   * Absolute glob patterns for paths this rule matches.
   * Must start with `/`; must not contain `..` or `~`.
   * Supports `**` (any depth), `*` (within one segment), and `{a,b}` brace expansion.
   */
  paths: string[];

  /**
   * Whether matching paths are permitted, blocked, or paused for human approval.
   *
   * - `"allow"` (default): operation proceeds normally.
   * - `"deny"`: operation is rejected with a permission error.
   * - `"interrupt"`: matching tool calls pause for human approval via
   *   `HumanInTheLoopMiddleware` (auto-installed when any interrupt-mode
   *   rule is present).
   */
  mode?: PermissionMode;
}
