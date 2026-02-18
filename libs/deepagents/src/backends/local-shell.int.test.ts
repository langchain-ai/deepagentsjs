/**
 * Integration tests for LocalShellBackend using the standard sandbox test suite.
 *
 * Runs the full set of standard sandbox tests (command execution, file
 * operations, read, write, edit, ls, grep, glob, etc.) against a real
 * LocalShellBackend backed by the local filesystem.
 *
 * @vitest-environment node
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sandboxStandardTests } from "@langchain/sandbox-standard-tests/vitest";
import { LocalShellBackend } from "./local-shell.js";

const TEST_TIMEOUT = 120_000; // 2 minutes

sandboxStandardTests({
  name: "LocalShellBackend",
  sequential: true,
  timeout: TEST_TIMEOUT,
  createSandbox: async (options) => {
    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "deepagents-int-test-"),
    );
    return LocalShellBackend.create({
      rootDir: tmpDir,
      inheritEnv: true,
      ...options,
    });
  },
  createUninitializedSandbox: () => {
    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "deepagents-int-test-"),
    );
    return new LocalShellBackend({
      rootDir: tmpDir,
      inheritEnv: true,
    });
  },
  closeSandbox: (sandbox) => sandbox.close(),
  resolvePath: (name) => name,
});
