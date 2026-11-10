/**
 * Regression tests for the ACP permission gate: tools must not run until the
 * client explicitly allows them.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AIMessage } from "@langchain/core/messages";
import { fakeModel } from "langchain";
import { DeepAgentsServer } from "./server.js";

describe("ACP permission gate", () => {
  let workspace: string;
  let marker: string;

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "acp-perm-"));
    marker = path.join(workspace, "marker.txt");
  });

  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  async function prompt(requestPermission: () => Promise<unknown>) {
    const server = new DeepAgentsServer({
      agents: {
        name: "poc-agent",
        model: fakeModel()
          .respondWithTools([
            {
              name: "write_file",
              args: { file_path: marker, content: "written\n" },
              id: "call_poc1",
            },
          ])
          .respond(new AIMessage("done")),
      },
      workspaceRoot: workspace,
    });
    const conn = {
      sessionUpdate: vi.fn().mockResolvedValue(undefined),
      requestPermission: vi.fn(requestPermission),
    };
    const serverAny = server as unknown as {
      connection: unknown;
      handleNewSession: (
        params: Record<string, unknown>,
        conn: unknown,
      ) => Promise<{ sessionId: string }>;
      handlePrompt: (
        params: Record<string, unknown>,
        conn: unknown,
      ) => Promise<{ stopReason: string }>;
    };
    serverAny.connection = conn;
    const { sessionId } = await serverAny.handleNewSession({}, conn);
    const result = await serverAny.handlePrompt(
      { sessionId, prompt: [{ type: "text", text: "do the write" }] },
      conn,
    );
    return { result, conn };
  }

  it("denies the tool call when the client can't ask for permission", async () => {
    const { result, conn } = await prompt(() =>
      Promise.reject(
        Object.assign(new Error("Method not found"), { code: -32601 }),
      ),
    );

    expect(conn.requestPermission).toHaveBeenCalledTimes(1);
    expect(result.stopReason).toBe("cancelled");
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("does not run the tool while the permission request is pending", async () => {
    let existedWhilePending: boolean | undefined;
    const { result } = await prompt(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      existedWhilePending = fs.existsSync(marker);
      return { outcome: { outcome: "selected", optionId: "reject-once" } };
    });

    expect(existedWhilePending).toBe(false);
    expect(result.stopReason).toBe("cancelled");
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("runs the tool once the client allows it", async () => {
    const { result } = await prompt(async () => ({
      outcome: { outcome: "selected", optionId: "allow-once" },
    }));

    expect(result.stopReason).toBe("end_turn");
    expect(fs.readFileSync(marker, "utf8")).toBe("written\n");
  });
});
