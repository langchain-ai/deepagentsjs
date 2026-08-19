import { describe, it, expect } from "vitest";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { createDeepAgent } from "../index.js";
import type { FileData } from "../backends/protocol.js";

/**
 * End-to-end delete-tool tests that drive a full {@link createDeepAgent} graph
 * with a deterministic model, mirroring Python's `TestDeleteFileTool`
 * (test_end_to_end.py). The fake model emits a single `delete` tool call and
 * then a final assistant message, so the agent actually routes the call through
 * the filesystem middleware and default StateBackend.
 */

/** Build a v1 FileData entry for seeding the agent's `files` state. */
function fileData(content: string): FileData {
  return {
    content: [content],
    created_at: "2021-01-01",
    modified_at: "2021-01-01",
  } as FileData;
}

/** A model that requests one `delete` for `filePath`, then replies "Done." */
function deletingModel(filePath: string): FakeListChatModel {
  return new FakeListChatModel({
    responses: [
      new AIMessage({
        content: "",
        tool_calls: [
          {
            id: "call_1",
            name: "delete",
            args: { file_path: filePath },
          },
        ],
      }) as unknown as string,
      "Done.",
    ],
  });
}

function toolMessages(messages: unknown[]): ToolMessage[] {
  return messages.filter((m): m is ToolMessage =>
    ToolMessage.isInstance(m),
  ) as ToolMessage[];
}

describe("delete tool end-to-end", () => {
  it("removes an existing file and reports success", async () => {
    const agent = createDeepAgent({ model: deletingModel("/keep.txt") });

    const result = await agent.invoke({
      messages: [new HumanMessage("delete keep")],
      files: {
        "/keep.txt": fileData("bye"),
        "/other.txt": fileData("stay"),
      },
    } as never);

    const deletes = toolMessages(result.messages).filter(
      (m) => m.name === "delete",
    );
    expect(deletes).toHaveLength(1);
    expect(deletes[0].status).not.toBe("error");
    expect(deletes[0].content.toString()).toContain("Deleted /keep.txt");
    expect(Object.keys(result.files ?? {})).toEqual(["/other.txt"]);
  });

  it("recursively removes a directory's nested files", async () => {
    const agent = createDeepAgent({ model: deletingModel("/work") });

    const result = await agent.invoke({
      messages: [new HumanMessage("delete the work dir")],
      files: {
        "/work/a.txt": fileData("a"),
        "/work/sub/b.txt": fileData("b"),
        "/keep.txt": fileData("stay"),
      },
    } as never);

    const deletes = toolMessages(result.messages).filter(
      (m) => m.name === "delete",
    );
    expect(deletes[0].status).not.toBe("error");
    expect(Object.keys(result.files ?? {})).toEqual(["/keep.txt"]);
  });

  it("returns an error tool message for a missing path", async () => {
    const agent = createDeepAgent({ model: deletingModel("/nope.txt") });

    const result = await agent.invoke({
      messages: [new HumanMessage("delete nope")],
      files: { "/keep.txt": fileData("stay") },
    } as never);

    const deletes = toolMessages(result.messages).filter(
      (m) => m.name === "delete",
    );
    expect(deletes).toHaveLength(1);
    expect(deletes[0].status).toBe("error");
    expect(deletes[0].content.toString()).toContain("not found");
    // Nothing removed.
    expect(result.files?.["/keep.txt"]).toBeDefined();
  });

  it("blocks a denied delete and preserves the file in state", async () => {
    const agent = createDeepAgent({
      model: deletingModel("/secrets/key.txt"),
      permissions: [
        { operations: ["write"], paths: ["/secrets/**"], mode: "deny" },
      ],
    });

    const result = await agent.invoke({
      messages: [new HumanMessage("delete secret")],
      files: { "/secrets/key.txt": fileData("data") },
    } as never);

    const deletes = toolMessages(result.messages).filter(
      (m) => m.name === "delete",
    );
    expect(deletes).toHaveLength(1);
    expect(deletes[0].status).toBe("error");
    expect(deletes[0].content.toString()).toContain("permission denied");
    expect(deletes[0].content.toString()).toContain("write");
    // The denied file survives.
    expect(result.files?.["/secrets/key.txt"]).toBeDefined();
  });
});
