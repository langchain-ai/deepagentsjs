import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { SandboxInstance, StandardTestsConfig } from "../types.js";
import { withRetry } from "../sandbox.js";

/**
 * Register sandbox lifecycle tests (create, isRunning, close, two-step init).
 *
 * These tests use both the shared sandbox (for id/isRunning checks) and
 * temporary sandboxes (for close and two-step initialization).
 */
export function registerLifecycleTests<T extends SandboxInstance>(
  getShared: () => T,
  config: StandardTestsConfig<T>,
  timeout: number,
): void {
  describe("sandbox lifecycle", () => {
    it(
      "should create sandbox and have a valid id",
      () => {
        const shared = getShared();
        expect(shared).toBeDefined();
        expect(shared.id).toBeDefined();
        expect(typeof shared.id).toBe("string");
        expect(shared.id.length).toBeGreaterThan(0);
      },
      timeout,
    );

    it(
      "should have isRunning as true after creation",
      () => {
        expect(getShared().isRunning).toBe(true);
      },
      timeout,
    );

    const canBeClosed = typeof config.closeSandbox === "function";
    describe.skipIf(!canBeClosed)("close", () => {
      let tmp: T;

      beforeAll(async () => {
        tmp = await withRetry(() => config.createSandbox());
      }, timeout);

      afterAll(async () => {
        try {
          await config.closeSandbox?.(tmp);
        } catch {
          // Ignore cleanup errors
        }
      }, timeout);

      it(
        "should close sandbox successfully",
        async () => {
          expect(tmp.isRunning).toBe(true);

          await config.closeSandbox?.(tmp);

          expect(tmp.isRunning).toBe(false);
        },
        timeout,
      );
    });

    describe("two-step initialization", () => {
      let tmp: T;

      afterAll(async () => {
        try {
          if (tmp) await config.closeSandbox?.(tmp);
        } catch {
          // Ignore cleanup errors
        }
      }, timeout);

      it.skipIf(!config.createUninitializedSandbox)(
        "should work with two-step initialization",
        async () => {
          tmp = config.createUninitializedSandbox!();

          expect(tmp.isRunning).toBe(false);

          await withRetry(() => tmp.initialize!());

          expect(tmp.isRunning).toBe(true);
          expect(tmp.id).toBeDefined();
        },
        timeout,
      );
    });
  });
}
