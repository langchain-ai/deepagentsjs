/**
 * Internal hook: resolves a path to the target a backend would actually touch
 * (following symlinks), so permissions can be checked on it. Not exported.
 */

import type { MaybePromise } from "./protocol.js";

export type RealpathFn = (path: string) => MaybePromise<string>;

// `Symbol.for` so the key matches across duplicate copies of the package.
export const REALPATH = Symbol.for("deepagents.realpath");

export function getRealpath(backend: unknown): RealpathFn | undefined {
  if (typeof backend !== "object" || backend === null) {
    return undefined;
  }
  const fn = (backend as { [REALPATH]?: unknown })[REALPATH];
  return typeof fn === "function" ? (fn as RealpathFn) : undefined;
}

export function setRealpath(target: object, fn: RealpathFn): void {
  Object.defineProperty(target, REALPATH, {
    value: fn,
    enumerable: false,
    configurable: true,
  });
}
