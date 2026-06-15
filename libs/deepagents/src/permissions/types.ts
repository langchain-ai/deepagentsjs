/**
 * The filesystem operations a permission rule can govern.
 */
export type FilesystemOperation = "read" | "write";

/**
 * Effect when a tool call matches a rule.
 *
 * - `"allow"` (default): the call proceeds.
 * - `"deny"`: the tool returns a permission-denied error.
 * - `"interrupt"`: the call is paused for human approval before it runs,
 *   via the same human-in-the-loop interrupt used by `interruptOn`.
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
   * What happens when this rule matches. Defaults to `"allow"`.
   *
   * - `"allow"`: the call proceeds.
   * - `"deny"`: the tool returns a permission-denied error.
   * - `"interrupt"`: the call pauses for human approval before it runs.
   *   Best paired with patterns that have a literal leading anchor (e.g.
   *   `/secrets/**`). Bulk tools (`ls`/`glob`/`grep`) fire the interrupt
   *   whenever their search subtree could overlap the rule's anchored
   *   prefix, so a fully unanchored pattern (`/**\/secrets`) conservatively
   *   over-fires for any bulk call.
   */
  mode?: PermissionMode;
}
