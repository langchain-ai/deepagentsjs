/**
 * The filesystem operation being performed.
 */
export type FilesystemOperation = "read" | "write";

/**
 * Whether a permission rule allows or denies matching paths.
 */
export type PermissionMode = "allow" | "deny";

/**
 * Constructor options for {@link FilesystemPermission}.
 */
export interface FilesystemPermissionOptions {
  /**
   * The operations this rule governs.
   */
  operations: FilesystemOperation[];

  /**
   * Glob patterns for paths this rule applies to. All patterns must be
   * absolute (start with `/`) and must not contain `..` or `~`.
   *
   * Supports `**` (any depth), `*` (within one segment), and `{a,b}`
   * brace expansion.
   */
  paths: string[];

  /**
   * Whether this rule allows or denies access for matching paths.
   * Defaults to `"allow"`.
   */
  mode?: PermissionMode;
}

/**
 * A single filesystem permission rule.
 *
 * Rules are evaluated in declaration order; the first rule whose
 * `operations` includes the requested operation AND whose `paths`
 * glob-matches the target path determines the outcome. If no rule
 * matches, access is **allowed** (permissive default).
 *
 * @example
 * ```ts
 * // Allow reads under /workspace, deny reads everywhere else.
 * const permissions = [
 *   new FilesystemPermission({
 *     operations: ["read"],
 *     paths: ["/workspace/**"],
 *     mode: "allow",
 *   }),
 *   new FilesystemPermission({
 *     operations: ["read"],
 *     paths: ["/**"],
 *     mode: "deny",
 *   }),
 * ];
 * ```
 */
export class FilesystemPermission {
  readonly operations: FilesystemOperation[];
  readonly paths: string[];
  readonly mode: PermissionMode;

  constructor({
    operations,
    paths,
    mode = "allow",
  }: FilesystemPermissionOptions) {
    this.operations = operations;
    this.paths = paths;
    this.mode = mode;

    for (const path of paths) {
      if (!path.startsWith("/")) {
        throw new Error(
          `Permission path must be absolute (start with "/"): ${JSON.stringify(path)}`,
        );
      }
      if (path.split("/").includes("..")) {
        throw new Error(
          `Permission path must not contain "..": ${JSON.stringify(path)}`,
        );
      }
      if (path.split("/").includes("~")) {
        throw new Error(
          `Permission path must not contain "~": ${JSON.stringify(path)}`,
        );
      }
    }
  }
}
