import { afterEach, describe, expect, it } from "vitest";

import { startViteWebUIServer } from "./vite-server.js";

const runtimes: Array<{ stop(): Promise<void> }> = [];

afterEach(async () => {
  while (runtimes.length > 0) {
    await runtimes.pop()?.stop();
  }
});

describe("vite web ui runtime", () => {
  it("serves the browser app and API endpoints", async () => {
    const runtime = await startViteWebUIServer({
      attached: {
        client: { id: "web-ui", transport: "web-ui" },
        async getInitialUpdates() {
          return [
            {
              kind: "snapshot",
              sessionId: "s1",
              timestamp: new Date().toISOString(),
              snapshot: {
                session: {
                  sessionId: "s1",
                  running: true,
                },
                threads: [],
              },
            },
          ];
        },
        async poll() {
          return { updates: [], nextCursor: undefined };
        },
        subscribe() {
          return () => {};
        },
        async steer() {
          return { commandId: "cmd-1", status: "queued" as const };
        },
        async lifecycle() {
          throw new Error("unsupported");
        },
        close() {},
      },
      options: {
        port: 3410,
        host: "127.0.0.1",
        allowSteering: false,
      },
    });
    runtimes.push(runtime);

    const [html, initial, config] = await Promise.all([
      fetch(`${runtime.url}/`).then((res) => res.text()),
      fetch(`${runtime.url}/api/initial`).then((res) => res.json()),
      fetch(`${runtime.url}/api/config`).then((res) => res.json()),
    ]);

    expect(html).toContain("DeepAgents UI");
    expect(initial.updates[0].snapshot.session.sessionId).toBe("s1");
    expect(config.allowSteering).toBe(false);
  });
});
