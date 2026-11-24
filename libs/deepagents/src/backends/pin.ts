/**
 * Internal hook: runs a single-path operation with the target's parent
 * directory held open, so the permission decision and the operation act on the
 * same directory even if a path component is swapped in between. Not exported.
 */

import type { MaybePromise } from "./protocol.js";

/** Returns an error message to deny the operation, or `undefined` to allow it. */
export type AuthorizeFn = (
  realPath: string,
) => MaybePromise<string | undefined>;

export interface PinOptions {
  /** Create missing parent directories (for writes). */
  create: boolean;
}

/**
 * Pins the parent of `path`, calls `authorize` with the target's real path,
 * and runs `operation` with I/O on `path` bound to the pinned directory.
 * Returns `{ error }` when `authorize` denies, and throws when the directory
 * cannot be pinned.
 */
export type PinFn = <T extends { error?: string }>(
  path: string,
  options: PinOptions,
  authorize: AuthorizeFn,
  operation: () => Promise<T>,
) => Promise<T | { error: string }>;

// `Symbol.for` so the key matches across duplicate copies of the package.
export const PIN = Symbol.for("deepagents.pin");

export function getPin(backend: unknown): PinFn | undefined {
  if (typeof backend !== "object" || backend === null) {
    return undefined;
  }
  const fn = (backend as { [PIN]?: unknown })[PIN];
  return typeof fn === "function" ? (fn as PinFn) : undefined;
}

export function setPin(target: object, fn: PinFn): void {
  Object.defineProperty(target, PIN, {
    value: fn,
    enumerable: false,
    configurable: true,
  });
}
