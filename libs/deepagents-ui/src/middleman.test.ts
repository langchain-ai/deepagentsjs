import { describe, expect, it, vi } from "vitest";

import { middleman } from "./middleman.js";

function createMockAttached() {
  return {
    client: { id: "client-1", transport: "acp" },
    getInitialUpdates: vi.fn().mockResolvedValue([]),
    poll: vi.fn().mockResolvedValue({ updates: [], nextCursor: undefined }),
    subscribe: vi.fn().mockReturnValue(() => {}),
    steer: vi.fn().mockResolvedValue({ commandId: "cmd-1", status: "queued" }),
    lifecycle: vi.fn().mockRejectedValue(new Error("unsupported")),
    close: vi.fn(),
  };
}

function createMockSession() {
  const attached = createMockAttached();
  return {
    attached,
    session: {
      getSnapshot: vi.fn(),
      getEvents: vi.fn(),
      send: vi.fn(),
      poll: vi.fn(),
      subscribe: vi.fn(),
      attachACPClient: vi.fn().mockReturnValue(attached),
    },
  };
}

describe("middleman", () => {
  it("wraps SessionHandle attachment for observe-only usage", async () => {
    const { session, attached } = createMockSession();
    const runtime = middleman({ session: session as any });

    const client = runtime.attachACPClient({ client: { id: "zed" } });
    await client.getInitialUpdates();

    expect(session.attachACPClient).toHaveBeenCalledWith(
      expect.objectContaining({
        client: expect.objectContaining({ id: "zed" }),
        allowSteering: false,
      }),
    );
    expect(attached.getInitialUpdates).toHaveBeenCalled();
  });

  it("requires explicit steering enablement", async () => {
    const { session } = createMockSession();
    const runtime = middleman({ session: session as any });
    const client = runtime.attachACPClient({
      client: { id: "zed" },
      allowSteering: true,
    });

    await expect(
      client.steer({
        kind: "reminder",
        target: "active",
        payload: { text: "remember" },
      } as any),
    ).rejects.toThrow("Steering is disabled");
  });

  it("passes through steering when enabled and permitted", async () => {
    const { session, attached } = createMockSession();
    const runtime = middleman({
      session: session as any,
      allowSteering: true,
      permissions: {
        canSteer: () => true,
      },
    });
    const client = runtime.attachACPClient({
      client: { id: "zed" },
      allowSteering: true,
    });

    await client.steer({
      kind: "reminder",
      target: "active",
      payload: { text: "remember" },
    } as any);

    expect(attached.steer).toHaveBeenCalled();
  });
});
