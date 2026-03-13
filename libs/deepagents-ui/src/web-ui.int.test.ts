import { afterEach, describe, expect, it } from "vitest";
import type { SessionHandle } from "deepagents";

import { middleman } from "./middleman.js";

const runtimes: Array<{ stop(): Promise<void> }> = [];

afterEach(async () => {
  while (runtimes.length > 0) {
    await runtimes.pop()?.stop();
  }
});

describe("web ui integration", () => {
  it(
    "serves a SessionHandle-backed session through the local UI runtime",
    { timeout: 60_000 },
    async () => {
      const session: SessionHandle = {
        async getSnapshot() {
          return {
            session: {
              sessionId: "ui-int-session",
              running: true,
              activeThreadId: "root",
              updatedAt: new Date().toISOString(),
            },
            threads: [
              {
                threadId: "root",
                agentKind: "root",
                status: "running",
                latestSummary: "Updating docs",
              },
            ],
            todos: [{ content: "Update docs", status: "in_progress" }],
            files: [{ path: "/tmp/docs.md", operation: "edit" }],
          };
        },
        async getEvents() {
          return {
            events: [
              {
                id: "evt-1",
                sessionId: "ui-int-session",
                threadId: "root",
                type: "model_response",
                timestamp: new Date().toISOString(),
                content: "I am updating the docs now.",
              },
            ],
          };
        },
        async send() {
          return { commandId: "cmd-1", status: "queued" as const };
        },
        async poll() {
          return {
            updates: [
              {
                kind: "message",
                sessionId: "ui-int-session",
                timestamp: new Date().toISOString(),
                message: {
                  threadId: "root",
                  content: "I am updating the docs now.",
                },
              },
            ],
          };
        },
        subscribe() {
          return () => {};
        },
        attachACPClient() {
          return {
            client: { id: "web-ui", transport: "web-ui" },
            async getInitialUpdates() {
              return [
                {
                  kind: "snapshot",
                  sessionId: "ui-int-session",
                  timestamp: new Date().toISOString(),
                  snapshot: await session.getSnapshot(),
                },
                ...(await session.poll()).updates,
              ];
            },
            poll: session.poll,
            subscribe: session.subscribe,
            async steer(input) {
              return session.send({
                ...input,
                target: input.target ?? "active",
                createdBy: "web-ui:web-ui",
              });
            },
            async lifecycle() {
              throw new Error("unsupported");
            },
            close() {},
          };
        },
      };
      const ui = middleman({ session });
      const runtime = ui.createWebUI({
        port: 3411,
        host: "127.0.0.1",
      });
      runtimes.push(runtime);
      await runtime.start();

      const initial = await fetch(`${runtime.url}/api/initial`).then((res) =>
        res.json(),
      );

      expect(initial.updates.some((update: any) => update.kind === "snapshot")).toBe(
        true,
      );
      expect(initial.updates.some((update: any) => update.kind === "message")).toBe(true);
    },
  );
});
