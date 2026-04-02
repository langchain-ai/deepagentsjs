/**
 * Vitest convenience entry point for `@langchain/sandbox-standard-tests`.
 *
 * Importing from this sub-path automatically injects the Vitest test
 * primitives so you don't have to pass them yourself:
 *
 * @example
 * ```ts
 * import { sandboxStandardTests } from "@langchain/sandbox-standard-tests/vitest";
 *
 * sandboxStandardTests({
 *   name: "MySandbox",
 *   createSandbox: (opts) => MySandbox.create(opts),
 *   resolvePath: (name) => `/tmp/${name}`,
 * });
 * ```
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";

import {
  sandboxStandardTests as baseSandboxStandardTests,
  withRetry,
} from "./sandbox.js";
import type {
  AnySandboxInstance,
  StandardTestsConfig,
  TestRunner,
} from "./types.js";

const vitestRunner: TestRunner = {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
};

/**
 * Configuration accepted by the Vitest-flavoured entry point.
 *
 * Identical to `StandardTestsConfig` but `runner` is optional — it
 * defaults to the Vitest primitives.
 */
export type VitestStandardTestsConfig<
  T extends AnySandboxInstance = AnySandboxInstance,
> = Omit<StandardTestsConfig<T>, "runner"> & {
  runner?: StandardTestsConfig<T>["runner"];
};

/**
 * Run the standard sandbox integration tests using Vitest as the runner.
 */
export function sandboxStandardTests<T extends AnySandboxInstance>(
  config: VitestStandardTestsConfig<T>,
): void {
  baseSandboxStandardTests({
    ...config,
    runner: config.runner ?? vitestRunner,
  } as StandardTestsConfig<T>);
}

export { withRetry };

export type {
  SandboxInstance,
  SandboxInstanceV1,
  SandboxInstanceV2,
  AnySandboxInstance,
  StandardTestsConfig,
  TestRunner,
  SuiteFn,
  TestFn,
  HookFn,
  ExpectFn,
} from "./types.js";
