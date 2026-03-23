/**
 * @langchain/sandbox-standard-tests — shared integration test suites
 * for deepagents sandbox providers.
 *
 * The root entry point is **framework-agnostic**: you must supply
 * test-runner primitives (`describe`, `it`, `expect`, …) via the
 * `runner` config property.
 *
 * For Vitest users there is a convenience sub-export that pre-fills
 * the runner automatically:
 *
 * @example
 * ```ts
 * // Framework-agnostic (bring your own runner)
 * import { sandboxStandardTests } from "@langchain/sandbox-standard-tests";
 *
 * // Vitest shorthand
 * import { sandboxStandardTests } from "@langchain/sandbox-standard-tests/vitest";
 * ```
 */

export { sandboxStandardTests, withRetry } from "./sandbox.js";

export type {
  SandboxInstance,
  StandardTestsConfig,
  TestRunner,
  SuiteFn,
  TestFn,
  HookFn,
  ExpectFn,
} from "./types.js";
