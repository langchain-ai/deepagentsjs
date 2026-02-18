/**
 * Standard integration test suite for sandbox providers.
 *
 * This module provides a reusable set of integration tests that verify
 * common sandbox behavior across all provider implementations. Each provider
 * calls `sandboxStandardTests()` with its own configuration to run these
 * tests against its sandbox implementation.
 *
 * **Design**: A single shared sandbox is created once (in `beforeAll`) and
 * reused across all command-execution and file-operation tests. Only
 * lifecycle tests that verify create/close behaviour and initialFiles tests
 * that require a fresh sandbox spin up a temporary instance — and they tear
 * it down immediately inside the test so the concurrent sandbox count never
 * exceeds 2.
 *
 * Tests cover:
 * - Sandbox lifecycle (create, isRunning, close, two-step initialization)
 * - Command execution (echo, exit codes, multiline output, stderr, env vars)
 * - File operations (upload, download, read, write, edit, multiple files)
 * - write() (new file, parent dirs, existing file, special chars, unicode, long content)
 * - read() (basic, nonexistent, offset, limit, offset+limit, unicode, chunked)
 * - edit() (single/multi occurrence, replaceAll, not found, special chars, multiline, unicode)
 * - lsInfo() (basic listing, empty dir, hidden files, large dir, absolute paths)
 * - grepRaw() (basic search, glob filter, case sensitivity, nested dirs, unicode)
 * - globInfo() (wildcard, recursive, extension filter, character classes, deeply nested)
 * - Initial files support (basic, nested, empty)
 * - Integration workflows (write-read-edit, complex directory operations)
 * - Error handling (file not found, non-existent command)
 */

import { describe, beforeAll, afterAll } from "vitest";

import { registerLifecycleTests } from "./tests/lifecycle.js";
import { registerCommandExecutionTests } from "./tests/command-execution.js";
import { registerFileOperationTests } from "./tests/file-operations.js";
import { registerWriteTests } from "./tests/write.js";
import { registerReadTests } from "./tests/read.js";
import { registerEditTests } from "./tests/edit.js";
import { registerLsInfoTests } from "./tests/ls-info.js";
import { registerGrepRawTests } from "./tests/grep-raw.js";
import { registerGlobInfoTests } from "./tests/glob-info.js";
import { registerInitialFilesTests } from "./tests/initial-files.js";
import { registerIntegrationTests } from "./tests/integration.js";
import type { SandboxInstance, StandardTestsConfig } from "./types.js";
/**
 * Default number of retry attempts for sandbox creation.
 */
const DEFAULT_MAX_RETRIES = 5;

/**
 * Default delay in milliseconds between retries.
 */
const DEFAULT_RETRY_DELAY_MS = 15_000;

/**
 * Retry an async operation with a fixed delay between attempts.
 *
 * Useful for working around transient sandbox concurrency limits:
 * when a provider rejects creation because the organisation has too
 * many running sandboxes, waiting a short while and retrying usually
 * succeeds once a previous sandbox finishes shutting down.
 *
 * @param fn - The async operation to attempt
 * @param maxRetries - Maximum number of attempts (default: 3)
 * @param delayMs - Milliseconds to wait between attempts (default: 10 000)
 * @returns The result of the first successful attempt
 *
 * @example
 * ```ts
 * const sandbox = await withRetry(() => DenoSandbox.create({ memoryMb: 768 }));
 * ```
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries: number = DEFAULT_MAX_RETRIES,
  delayMs: number = DEFAULT_RETRY_DELAY_MS,
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      if (attempt < maxRetries) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  throw lastError;
}

/**
 * Run the standard sandbox integration tests against a provider.
 *
 * A single shared sandbox is created in `beforeAll` and reused for the
 * majority of tests (command execution, file operations). Tests that
 * inherently need their own sandbox (lifecycle close/init, initialFiles)
 * create a temporary one and destroy it immediately, so the concurrent
 * sandbox count never exceeds **2** (shared + 1 temporary).
 *
 * @example
 * ```ts
 * import { sandboxStandardTests } from "@langchain/standard-tests";
 * import { ModalSandbox } from "./sandbox.js";
 *
 * sandboxStandardTests({
 *   name: "ModalSandbox",
 *   skip: !process.env.MODAL_TOKEN_ID,
 *   timeout: 180_000,
 *   createSandbox: (opts) =>
 *     ModalSandbox.create({ imageName: "alpine:3.21", ...opts }),
 *   createUninitializedSandbox: () =>
 *     new ModalSandbox({ imageName: "alpine:3.21" }),
 *   closeSandbox: (sb) => sb.close(),
 *   resolvePath: (name) => `/tmp/${name}`,
 * });
 * ```
 */
export function sandboxStandardTests<T extends SandboxInstance>(
  config: StandardTestsConfig<T>,
): void {
  const timeout = config.timeout ?? 120_000;

  // Choose the right describe variant based on config
  const outerDescribe = config.skip
    ? describe.skip
    : config.sequential
      ? describe.sequential
      : describe;

  outerDescribe(`${config.name} Standard Tests`, () => {
    // The single shared sandbox reused across most tests
    let shared: T;
    const getShared = () => shared;

    beforeAll(async () => {
      shared = await withRetry(() => config.createSandbox());
    }, timeout);

    afterAll(async () => {
      try {
        await config.closeSandbox?.(shared);
      } catch {
        // Ignore cleanup errors
      }
    }, timeout);

    // Register all test suites
    registerLifecycleTests(getShared, config, timeout);
    registerCommandExecutionTests(getShared, config, timeout);
    registerFileOperationTests(getShared, config, timeout);
    registerWriteTests(getShared, config, timeout);
    registerReadTests(getShared, config, timeout);
    registerEditTests(getShared, config, timeout);
    registerLsInfoTests(getShared, config, timeout);
    registerGrepRawTests(getShared, config, timeout);
    registerGlobInfoTests(getShared, config, timeout);
    registerInitialFilesTests(config, timeout);
    registerIntegrationTests(getShared, config, timeout);
  });
}
