import { createMiddleware } from "langchain";
import { FS_PERMISSIONS_RUNTIME_KEY } from "../permissions/runtime.js";
import type { FilesystemPermission } from "../permissions/types.js";

/**
 * Options for {@link createFilesystemPermissionsMiddleware}.
 */
export interface CreateFilesystemPermissionsMiddlewareOptions {
  /**
   * The filesystem permission rules to enforce.
   */
  rules: FilesystemPermission[];
}

/**
 * Creates middleware that threads filesystem permission rules into
 * `RunnableConfig.configurable` so that downstream tool policies
 * (both agent-invoked and PTC-invoked) can read and enforce them.
 *
 * @internal
 */
export function createFilesystemPermissionsMiddleware(
  options: CreateFilesystemPermissionsMiddlewareOptions,
) {
  const { rules } = options;

  return createMiddleware({
    name: "FilesystemPermissionsMiddleware",
    wrapModelCall: async (request, handler) => {
      return handler({
        ...request,
        runtime: {
          ...request.runtime,
          configurable: {
            ...request.runtime.configurable,
            [FS_PERMISSIONS_RUNTIME_KEY]: rules,
          },
        },
      });
    },
  });
}
