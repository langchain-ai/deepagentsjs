/**
 * Integration tests for LangSmithSandbox.
 *
 * These tests require a valid LANGSMITH_API_KEY and a deployed "deepagents-cli"
 * sandbox template in LangSmith. They will be skipped automatically when
 * credentials are not set.
 *
 * Known expected failures (LangSmith platform behaviour):
 * - "download error: permission denied": LangSmith runs as root; ignores file permissions.
 * - "download error: invalid path (relative)": Returns file_not_found for relative paths.
 * - "upload: relative path returns invalid_path": LangSmith accepts relative paths on upload.
 *
 * To run:
 *   export LANGSMITH_API_KEY=your_api_key
 *   pnpm test:int --reporter=verbose
 */

import { sandboxStandardTests } from "@langchain/sandbox-standard-tests/vitest";
import { SandboxClient } from "langsmith/experimental/sandbox";
import { LangSmithSandbox } from "./langsmith.js";

const LANGSMITH_API_KEY = process.env.LANGSMITH_API_KEY;
const hasCredentials = !!LANGSMITH_API_KEY;
const TEMPLATE_NAME = "deepagents-cli";
const TEST_TIMEOUT = 180_000; // 3 minutes

sandboxStandardTests({
  name: "LangSmithSandbox",
  skip: !hasCredentials,
  timeout: TEST_TIMEOUT,
  sequential: true,

  createSandbox: async () => {
    const client = new SandboxClient({ apiKey: LANGSMITH_API_KEY });
    const lsSandbox = await client.createSandbox(TEMPLATE_NAME);
    return new LangSmithSandbox({ sandbox: lsSandbox });
  },

  // LangSmithSandbox wraps an already-created instance — no two-step lifecycle.
  // Setting this to undefined skips the two-step initialization lifecycle test.
  createUninitializedSandbox: undefined,

  closeSandbox: async (sandbox) => {
    await sandbox.close();
  },

  resolvePath: (name) => `/tmp/${name}`,
});
