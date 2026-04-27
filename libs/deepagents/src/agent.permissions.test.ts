import { describe, it, expect } from "vitest";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import {
  AIMessage,
  HumanMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { MemorySaver } from "@langchain/langgraph";
import { createDeepAgent } from "./agent.js";
import { FilesystemPermission } from "./permissions/index.js";
import { createFileData } from "./backends/utils.js";

/**
 * Finds the first ToolMessage with the given tool name in a message list.
 */
function getToolMessage(
  messages: BaseMessage[],
  toolName: string,
): ToolMessage | undefined {
  return messages.find(
    (msg): msg is ToolMessage =>
      ToolMessage.isInstance(msg) && (msg as ToolMessage).name === toolName,
  ) as ToolMessage | undefined;
}

/**
 * Extracts plain text from a ToolMessage whose content may be a string or an
 * array of content blocks (e.g. from read_file).
 */
function toolMessageText(msg: ToolMessage): string {
  const { content } = msg;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) =>
        typeof b === "object" && b !== null && "text" in b
          ? String((b as { text: unknown }).text)
          : JSON.stringify(b),
      )
      .join("\n");
  }
  return String(content);
}

describe("createDeepAgent permissions integration", () => {
  it("read_file: denied path causes agent to reject with permission denied", async () => {
    const model = new FakeListChatModel({
      responses: [
        new AIMessage({
          content: "",
          tool_calls: [
            {
              id: "call_read_denied",
              name: "read_file",
              args: { file_path: "/secrets/key.txt" },
            },
          ],
        }) as unknown as string,
        "Done",
        "Done",
        "Done",
      ],
    });

    const agent = createDeepAgent({
      model,
      checkpointer: new MemorySaver(),
      permissions: [
        new FilesystemPermission({
          operations: ["read"],
          paths: ["/secrets/**"],
          mode: "deny",
        }),
      ],
    });

    await expect(
      agent.invoke(
        { messages: [new HumanMessage("Read the secrets file")] },
        {
          configurable: { thread_id: `perm-read-denied-${Date.now()}` },
          recursionLimit: 50,
        },
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it("read_file: allowed path returns file content", async () => {
    const model = new FakeListChatModel({
      responses: [
        new AIMessage({
          content: "",
          tool_calls: [
            {
              id: "call_read_allowed",
              name: "read_file",
              args: { file_path: "/workspace/hello.txt" },
            },
          ],
        }) as unknown as string,
        "Done",
        "Done",
        "Done",
      ],
    });

    const agent = createDeepAgent({
      model,
      checkpointer: new MemorySaver(),
      permissions: [
        new FilesystemPermission({
          operations: ["read"],
          paths: ["/secrets/**"],
          mode: "deny",
        }),
      ],
    });

    const result = await agent.invoke(
      {
        messages: [new HumanMessage("Read the workspace file")],
        files: {
          "/workspace/hello.txt": createFileData("hello world"),
        },
      },
      {
        configurable: { thread_id: `perm-read-allowed-${Date.now()}` },
        recursionLimit: 50,
      },
    );

    const toolMsg = getToolMessage(result.messages, "read_file");
    expect(toolMsg).toBeDefined();
    const text = toolMessageText(toolMsg!);
    expect(text).not.toMatch(/permission denied/i);
    expect(text).toContain("hello world");
  });

  it("write_file: denied path causes agent to reject with permission denied", async () => {
    const model = new FakeListChatModel({
      responses: [
        new AIMessage({
          content: "",
          tool_calls: [
            {
              id: "call_write_denied",
              name: "write_file",
              args: { file_path: "/readonly/config.json", content: "data" },
            },
          ],
        }) as unknown as string,
        "Done",
        "Done",
        "Done",
      ],
    });

    const agent = createDeepAgent({
      model,
      checkpointer: new MemorySaver(),
      permissions: [
        new FilesystemPermission({
          operations: ["write"],
          paths: ["/readonly/**"],
          mode: "deny",
        }),
      ],
    });

    await expect(
      agent.invoke(
        { messages: [new HumanMessage("Write to the readonly config")] },
        {
          configurable: { thread_id: `perm-write-denied-${Date.now()}` },
          recursionLimit: 50,
        },
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it("ls: denied base path causes agent to reject with permission denied", async () => {
    const model = new FakeListChatModel({
      responses: [
        new AIMessage({
          content: "",
          tool_calls: [
            {
              id: "call_ls_denied",
              name: "ls",
              args: { path: "/secrets" },
            },
          ],
        }) as unknown as string,
        "Done",
        "Done",
        "Done",
      ],
    });

    const agent = createDeepAgent({
      model,
      checkpointer: new MemorySaver(),
      permissions: [
        new FilesystemPermission({
          operations: ["read"],
          paths: ["/secrets/**", "/secrets"],
          mode: "deny",
        }),
      ],
    });

    await expect(
      agent.invoke(
        { messages: [new HumanMessage("List the secrets directory")] },
        {
          configurable: { thread_id: `perm-ls-denied-${Date.now()}` },
          recursionLimit: 50,
        },
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it("no permissions configured: read_file succeeds normally", async () => {
    const model = new FakeListChatModel({
      responses: [
        new AIMessage({
          content: "",
          tool_calls: [
            {
              id: "call_no_perm",
              name: "read_file",
              args: { file_path: "/workspace/data.txt" },
            },
          ],
        }) as unknown as string,
        "Done",
        "Done",
        "Done",
      ],
    });

    const agent = createDeepAgent({
      model,
      checkpointer: new MemorySaver(),
    });

    const result = await agent.invoke(
      {
        messages: [new HumanMessage("Read the data file")],
        files: {
          "/workspace/data.txt": createFileData("test data"),
        },
      },
      {
        configurable: { thread_id: `no-perm-${Date.now()}` },
        recursionLimit: 50,
      },
    );

    const toolMsg = getToolMessage(result.messages, "read_file");
    expect(toolMsg).toBeDefined();
    const text = toolMessageText(toolMsg!);
    expect(text).not.toMatch(/permission denied/i);
    expect(text).toContain("test data");
  });
});
