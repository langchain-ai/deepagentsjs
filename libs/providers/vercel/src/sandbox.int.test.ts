/**
 * Integration tests for VercelSandbox.
 *
 * These tests require Vercel Sandbox credentials. They are skipped unless
 * a token or OIDC token is available.
 *
 * @vitest-environment node
 */

import { describe, it, expect, afterAll } from "vitest";
import {
  sandboxStandardTests,
  withRetry,
} from "@langchain/sandbox-standard-tests/vitest";
import { VercelSandbox } from "./sandbox.js";

const VERCEL_OIDC_TOKEN = process.env.VERCEL_OIDC_TOKEN;
const VERCEL_TOKEN = process.env.VERCEL_TOKEN;
const VERCEL_PROJECT_ID = process.env.VERCEL_PROJECT_ID;
const VERCEL_TEAM_ID = process.env.VERCEL_TEAM_ID;
const hasExplicitCredentials = Boolean(
  VERCEL_TOKEN && VERCEL_PROJECT_ID && VERCEL_TEAM_ID,
);
const hasCredentials = Boolean(VERCEL_OIDC_TOKEN || hasExplicitCredentials);
const explicitCredentials = hasExplicitCredentials
  ? {
      token: VERCEL_TOKEN,
      projectId: VERCEL_PROJECT_ID,
      teamId: VERCEL_TEAM_ID,
    }
  : {};
const TEST_TIMEOUT = 180_000;

sandboxStandardTests({
  name: "VercelSandbox",
  skip: !hasCredentials,
  sequential: true,
  timeout: TEST_TIMEOUT,
  createSandbox: async (options) =>
    VercelSandbox.create({
      runtime: "node24",
      timeout: 30 * 60 * 1000,
      ...explicitCredentials,
      ...options,
    }),
  createUninitializedSandbox: () =>
    new VercelSandbox({
      runtime: "node24",
      timeout: 30 * 60 * 1000,
      ...explicitCredentials,
    }),
  closeSandbox: (sandbox) => sandbox.close(),
  resolvePath: (name) => name,
});

describe
  .skipIf(!hasCredentials)
  .sequential("VercelSandbox Provider-Specific Tests", () => {
    const persistentName = `deepagents-js-vercel-${Date.now()}`;
    let persistentSandbox: VercelSandbox | undefined;

    afterAll(async () => {
      try {
        await persistentSandbox?.delete();
      } catch {
        // Ignore cleanup errors.
      }
    }, TEST_TIMEOUT);

    it(
      "resumes a persistent named sandbox via getOrCreate and stop",
      async () => {
        const created = await withRetry(() =>
          VercelSandbox.getOrCreate({
            name: persistentName,
            persistent: true,
            runtime: "node24",
            timeout: 30 * 60 * 1000,
            ...explicitCredentials,
          }),
        );
        persistentSandbox = created;

        await created.execute('echo "persisted" > /vercel/sandbox/resume.txt');
        await created.stop();

        const resumed = await withRetry(() =>
          VercelSandbox.getOrCreate({
            name: persistentName,
            persistent: true,
            runtime: "node24",
            timeout: 30 * 60 * 1000,
            ...explicitCredentials,
          }),
        );
        persistentSandbox = resumed;

        const result = await resumed.execute("cat /vercel/sandbox/resume.txt");
        expect(result.exitCode).toBe(0);
        expect(result.output.trim()).toBe("persisted");
      },
      TEST_TIMEOUT,
    );
  });
