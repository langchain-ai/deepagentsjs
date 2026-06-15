import { describe, it, expect } from "vitest";
import { MemorySaver, Command } from "@langchain/langgraph";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { AIMessage } from "@langchain/core/messages";
import type { HITLRequest } from "langchain";

import { createDeepAgent } from "../agent.js";
import type { FilesystemPermission } from "../permissions/types.js";

function readFileModel(filePath: string): FakeListChatModel {
  return new FakeListChatModel({
    responses: [
      new AIMessage({
        content: "",
        tool_calls: [
          { id: "call_1", name: "read_file", args: { file_path: filePath } },
        ],
      }) as unknown as string,
      "Done",
      "Done",
    ],
  });
}

const INTERRUPT_READ: FilesystemPermission[] = [
  { operations: ["read"], paths: ["/secrets/**"], mode: "interrupt" },
];

describe("createFilesystemInterruptMiddleware (via createDeepAgent)", () => {
  it("interrupts read_file when the path matches an interrupt rule", async () => {
    const checkpointer = new MemorySaver();
    const agent = createDeepAgent({
      model: readFileModel("/secrets/key.txt"),
      permissions: INTERRUPT_READ,
      checkpointer,
    });

    const config = { configurable: { thread_id: crypto.randomUUID() } };
    const result = await agent.invoke(
      { messages: [{ role: "user", content: "read the secret" }] },
      config,
    );

    expect(result.__interrupt__).toBeDefined();
    const request = result.__interrupt__?.[0].value as HITLRequest;
    expect(request.actionRequests.some((ar) => ar.name === "read_file")).toBe(
      true,
    );
  });

  it("does not interrupt read_file for an unrelated path", async () => {
    const checkpointer = new MemorySaver();
    const agent = createDeepAgent({
      model: readFileModel("/workspace/notes.txt"),
      permissions: INTERRUPT_READ,
      checkpointer,
    });

    const config = { configurable: { thread_id: crypto.randomUUID() } };
    const result = await agent.invoke(
      { messages: [{ role: "user", content: "read my notes" }] },
      config,
    );

    expect(result.__interrupt__).toBeUndefined();
  });

  it("does not interrupt when there are no interrupt-mode rules", async () => {
    const checkpointer = new MemorySaver();
    const agent = createDeepAgent({
      model: readFileModel("/workspace/notes.txt"),
      permissions: [
        { operations: ["read"], paths: ["/secrets/**"], mode: "deny" },
      ],
      checkpointer,
    });

    const config = { configurable: { thread_id: crypto.randomUUID() } };
    const result = await agent.invoke(
      { messages: [{ role: "user", content: "read my notes" }] },
      config,
    );

    expect(result.__interrupt__).toBeUndefined();
  });

  it("resumes execution after the operation is approved", async () => {
    const checkpointer = new MemorySaver();
    const agent = createDeepAgent({
      model: readFileModel("/secrets/key.txt"),
      permissions: INTERRUPT_READ,
      checkpointer,
    });

    const config = { configurable: { thread_id: crypto.randomUUID() } };
    await agent.invoke(
      { messages: [{ role: "user", content: "read the secret" }] },
      config,
    );

    const resumed = await agent.invoke(
      new Command({ resume: { decisions: [{ type: "approve" }] } }),
      config,
    );

    expect(resumed.__interrupt__).toBeUndefined();
  });
});
