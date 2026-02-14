import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { DeepwasmBackend } from "../src/backend.js";

/**
 * Integration tests for the subagent spawning pipeline.
 *
 * Tests exercise the full flow: bash writes JSON to /.rpc/requests/ inside the
 * WASIX sandbox → files sync back to the in-memory FS → DeepwasmBackend parses
 * them as SpawnRequest objects.
 *
 * The deepagent CLI binary may not be mounted, so we simulate the RPC write
 * with plain bash (mkdir + echo).
 *
 * Requires @wasmer/sdk; skipped automatically if SDK fails to initialize.
 */

// Probe whether the SDK can initialize before running any tests.
let sdkAvailable = true;
try {
  const probe = await DeepwasmBackend.create();
  await probe.execute("echo probe");
  probe.close();
} catch {
  sdkAvailable = false;
}

const describeIfSdk = sdkAvailable ? describe : describe.skip;

describeIfSdk("Subagent spawning integration", { timeout: 120_000 }, () => {
  let backend: DeepwasmBackend;

  beforeAll(async () => {
    backend = await DeepwasmBackend.create();
  }, 60_000);

  afterAll(() => {
    backend?.close();
  });

  it("collects a basic spawn request written by bash", async () => {
    const json = JSON.stringify({
      id: "spawn-basic-1",
      method: "spawn",
      args: { task: "analyze code" },
      timestamp: "1700000000.0",
    });

    const result = await backend.execute(
      `mkdir -p /work/.rpc/requests && echo '${json}' > /work/.rpc/requests/spawn-basic-1.json`,
    );

    expect(result.spawnRequests).toHaveLength(1);
    expect(result.spawnRequests[0].id).toBe("spawn-basic-1");
    expect(result.spawnRequests[0].method).toBe("spawn");
    expect(result.spawnRequests[0].args.task).toBe("analyze code");
  }, 30_000);

  it("collects multiple spawn requests from one execution", async () => {
    const req1 = JSON.stringify({
      id: "multi-1",
      method: "spawn",
      args: { task: "task one" },
      timestamp: "1700000001.0",
    });
    const req2 = JSON.stringify({
      id: "multi-2",
      method: "spawn",
      args: { task: "task two" },
      timestamp: "1700000002.0",
    });

    const result = await backend.execute(
      `mkdir -p /work/.rpc/requests && echo '${req1}' > /work/.rpc/requests/multi-1.json && echo '${req2}' > /work/.rpc/requests/multi-2.json`,
    );

    expect(result.spawnRequests).toHaveLength(2);
    const ids = result.spawnRequests.map((r) => r.id).sort();
    expect(ids).toEqual(["multi-1", "multi-2"]);
  }, 30_000);

  it("returns spawn requests alongside regular stdout", async () => {
    const json = JSON.stringify({
      id: "with-output-1",
      method: "spawn",
      args: { task: "background task" },
      timestamp: "1700000003.0",
    });

    const result = await backend.execute(
      `echo hello_world && mkdir -p /work/.rpc/requests && echo '${json}' > /work/.rpc/requests/with-output-1.json`,
    );

    expect(result.output).toContain("hello_world");
    expect(result.spawnRequests).toHaveLength(1);
    expect(result.spawnRequests[0].args.task).toBe("background task");
  }, 30_000);

  it("returns empty spawnRequests when no requests are written", async () => {
    const result = await backend.execute("echo no_spawns_here");
    expect(result.output).toContain("no_spawns_here");
    expect(result.spawnRequests).toEqual([]);
  }, 15_000);

  it("parses spawn request with all required fields", async () => {
    const json = JSON.stringify({
      id: "format-check-1",
      method: "spawn",
      args: { task: "verify format" },
      timestamp: "1700000004.123",
    });

    const result = await backend.execute(
      `mkdir -p /work/.rpc/requests && echo '${json}' > /work/.rpc/requests/format-check-1.json`,
    );

    expect(result.spawnRequests).toHaveLength(1);
    const req = result.spawnRequests[0];
    expect(req).toEqual({
      id: "format-check-1",
      method: "spawn",
      args: { task: "verify format" },
      timestamp: "1700000004.123",
    });
  }, 30_000);

  it("cleans up requests so they are not re-read on next execute", async () => {
    const json = JSON.stringify({
      id: "cleanup-1",
      method: "spawn",
      args: { task: "ephemeral task" },
      timestamp: "1700000005.0",
    });

    // First execution writes and collects the request
    const result1 = await backend.execute(
      `mkdir -p /work/.rpc/requests && echo '${json}' > /work/.rpc/requests/cleanup-1.json`,
    );
    expect(result1.spawnRequests).toHaveLength(1);
    expect(result1.spawnRequests[0].id).toBe("cleanup-1");

    // Second execution should find no leftover requests
    const result2 = await backend.execute("echo after_cleanup");
    expect(result2.output).toContain("after_cleanup");
    expect(result2.spawnRequests).toEqual([]);
  }, 60_000);

  it("ignores malformed JSON without erroring", async () => {
    const result = await backend.execute(
      `mkdir -p /work/.rpc/requests && echo 'not valid json{{{' > /work/.rpc/requests/bad.json`,
    );

    // Should not throw, and spawnRequests should be empty
    expect(result.spawnRequests).toEqual([]);
  }, 30_000);
});
