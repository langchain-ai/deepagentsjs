import type { FilesystemOperation } from "./types.js";

/**
 * Key under which filesystem permission rules live in
 * `RunnableConfig.configurable`. Internal — do not depend on this
 * value from outside the permissions module.
 *
 * @internal
 */
export const FS_PERMISSIONS_RUNTIME_KEY = "deepagents:fs-permissions";

/**
 * Helper type passed to `FilesystemPolicy.filter` callbacks: given an
 * operation and an absolute path, returns whether access is allowed.
 *
 * @internal
 */
export type PathDecider = (
  operation: FilesystemOperation,
  path: string,
) => "allow" | "deny";
