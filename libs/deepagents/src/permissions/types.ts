/**
 * Filesystem operations that a {@link FilesystemPermission} rule may govern.
 */
export type FilesystemOperation = "read" | "write";

/**
 * Whether a permission rule allows or denies the matched operation.
 */
export type PermissionMode = "allow" | "deny";

/**
 * Options for constructing a {@link FilesystemPermission}.
 */
export interface FilesystemPermissionOptions {
  /**
   * The operations this rule applies to.
   */
  operations: FilesystemOperation[];

  /**
   * Absolute glob patterns to match against. Must start with `/` and must not contain `..` or `~`.
   */
  paths: string[];

  /**
   * Whether matching requests are allowed or denied.
   *
   * @defaultValue `"allow"`
   */
  mode?: PermissionMode;
}

/**
 * A single filesystem permission rule.
 *
 * Rules are evaluated in declaration order; the first rule whose
 * `operations` includes the requested operation and whose `paths`
 * matches the requested path determines the outcome. If no rule
 * matches, access is allowed (permissive default).
 *
 * @example
 * ```ts
 * // Deny writes anywhere under /secrets/.
 * new FilesystemPermission({
 *   operations: ["write"],
 *   paths: ["/secrets/**"],
 *   mode: "deny",
 * });
 * ```
 */
export class FilesystemPermission {
  /**
   * The operations this rule applies to (`"read"` or `"write"`).
   */
  readonly operations: FilesystemOperation[];

  /**
   * Absolute glob patterns to match against.
   */
  readonly paths: string[];

  /**
   * Whether matching requests are allowed or denied. Defaults to `"allow"`.
   */
  readonly mode: PermissionMode;

  constructor(options: FilesystemPermissionOptions) {
    this.operations = options.operations;
    this.paths = options.paths;
    this.mode = options.mode ?? "allow";

    for (const path of this.paths) {
      if (!path.startsWith("/")) {
        throw new Error(
          `Permission path must start with '/': ${JSON.stringify(path)}`,
        );
      }

      const parts = path.split("/");
      if (parts.includes("..")) {
        throw new Error(
          `Permission path must not contain '..': ${JSON.stringify(path)}`,
        );
      }

      if (parts.includes("~")) {
        throw new Error(
          `Permission path must not contain '~': ${JSON.stringify(path)}`,
        );
      }
    }
  }
}
