/**
 * Integration tests for SpritesSandbox.
 *
 * These tests create real Sprites (billable resources) and will be skipped
 * if SPRITES_TOKEN is not set.
 *
 * To run these tests:
 *   1. Create a Sprites API token (https://sprites.dev/docs)
 *   2. Set the environment variable:
 *      export SPRITES_TOKEN=your_token_here
 *   3. Run: pnpm test:int
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  sandboxStandardTests,
  withRetry,
} from "@langchain/sandbox-standard-tests/vitest";
import { randomBytes } from "node:crypto";

import { SpritesSandbox } from "./index.js";

const hasCredentials = !!process.env.SPRITES_TOKEN;

const TEST_TIMEOUT = 120_000; // 2 minutes

/**
 * Identify sandboxes created by this test execution. GitHub run ID and attempt
 * prevent cleanup in one CI run from deleting sandboxes owned by another.
 */
const TEST_RUN_ID = process.env.GITHUB_RUN_ID
  ? `${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT ?? "1"}`
  : `local-${randomBytes(3).toString("hex")}`;

/** All Sprites created by this run share this name prefix. */
const NAME_PREFIX = `ci-deepagents-${TEST_RUN_ID}-`;

function testName(): string {
  return `${NAME_PREFIX}${randomBytes(3).toString("hex")}`;
}

/** Remove any sandboxes left behind by this test execution. */
afterAll(async () => {
  if (!hasCredentials) return;
  await SpritesSandbox.deleteAll(NAME_PREFIX);
}, TEST_TIMEOUT);

sandboxStandardTests({
  name: "SpritesSandbox",
  skip: !hasCredentials,
  timeout: TEST_TIMEOUT,
  createSandbox: async (options) =>
    SpritesSandbox.create({
      name: testName(),
      labels: ["purpose:integration-test", "package:langchain-sprites"],
      ...options,
    }),
  closeSandbox: (sandbox) => sandbox.close(),
  resolvePath: (name) => name,
});

describe.skipIf(!hasCredentials)(
  "SpritesSandbox Provider-Specific Tests",
  () => {
    let sandbox: SpritesSandbox;

    beforeAll(async () => {
      sandbox = await withRetry(() =>
        SpritesSandbox.create({
          name: testName(),
          labels: ["purpose:integration-test", "package:langchain-sprites"],
        }),
      );
    }, TEST_TIMEOUT);

    afterAll(async () => {
      try {
        await sandbox?.close();
      } catch {
        // Ignore cleanup errors
      }
    }, TEST_TIMEOUT);

    it(
      "should run shell pipelines",
      async () => {
        const result = await sandbox.execute(
          "printf 'a\\nb\\nc\\n' | wc -l | tr -d ' '",
        );

        expect(result.exitCode).toBe(0);
        expect(result.output.trim()).toBe("3");
      },
      TEST_TIMEOUT,
    );

    it(
      "should get working directory",
      async () => {
        const workDir = await sandbox.getWorkDir();

        expect(workDir).toBeTruthy();
        expect(typeof workDir).toBe("string");
      },
      TEST_TIMEOUT,
    );

    it(
      "should get user home directory",
      async () => {
        const homeDir = await sandbox.getUserHomeDir();

        expect(homeDir).toBeTruthy();
        expect(homeDir.startsWith("/")).toBe(true);
      },
      TEST_TIMEOUT,
    );

    it(
      "should reconnect to an existing sandbox by name",
      async () => {
        const encoder = new TextEncoder();
        await sandbox.uploadFiles([
          ["reconnect-test.txt", encoder.encode("still here")],
        ]);

        const reconnected = await SpritesSandbox.fromName(sandbox.id);
        const results = await reconnected.downloadFiles(["reconnect-test.txt"]);

        expect(results[0].error).toBeNull();
        expect(new TextDecoder().decode(results[0].content!)).toBe(
          "still here",
        );
      },
      TEST_TIMEOUT,
    );

    it(
      "should checkpoint and restore filesystem state",
      async () => {
        const encoder = new TextEncoder();

        // Write a file and checkpoint
        await sandbox.uploadFiles([
          ["checkpoint-test.txt", encoder.encode("original")],
        ]);
        const checkpoint = await sandbox.checkpoint("integration-test");
        expect(checkpoint.id).toBeTruthy();

        // Modify the file, then roll back
        await sandbox.uploadFiles([
          ["checkpoint-test.txt", encoder.encode("modified")],
        ]);
        await sandbox.restore(checkpoint.id);

        const results = await sandbox.downloadFiles(["checkpoint-test.txt"]);
        expect(results[0].error).toBeNull();
        expect(new TextDecoder().decode(results[0].content!)).toBe("original");
      },
      TEST_TIMEOUT,
    );
  },
);

describe.skipIf(!hasCredentials)("SpritesSandbox initialFiles", () => {
  let sandbox: SpritesSandbox;

  beforeAll(async () => {
    sandbox = await withRetry(() =>
      SpritesSandbox.create({
        name: testName(),
        labels: ["purpose:integration-test", "package:langchain-sprites"],
        initialFiles: {
          "hello.sh": 'echo "Hello from initialFiles!"',
        },
      }),
    );
  }, TEST_TIMEOUT);

  afterAll(async () => {
    try {
      await sandbox?.close();
    } catch {
      // Ignore cleanup errors
    }
  }, TEST_TIMEOUT);

  it(
    "should create sandbox with initial files and execute them",
    async () => {
      expect(sandbox.isRunning).toBe(true);

      const result = await sandbox.execute("sh hello.sh");
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("Hello from initialFiles!");
    },
    TEST_TIMEOUT,
  );
});
