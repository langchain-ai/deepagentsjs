import { describe, expect, it, vi } from "vitest";
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import type { ToolCall } from "@langchain/core/messages/tool";
import { fakeModel } from "@langchain/core/testing";
import { InMemoryStore } from "@langchain/langgraph";
import { createAgent, type ToolCallRequest } from "langchain";
import { StoreBackend } from "../backends/store.js";
import { createFileData, fileDataToString } from "../backends/utils.js";
import { createFilesystemMiddleware } from "./fs.js";

type FilesystemToolCallRequest = Parameters<
  NonNullable<ReturnType<typeof createFilesystemMiddleware>["wrapToolCall"]>
>[0];

const ORIGINAL = "Search: authentication\nEvidence: any docs";
const SEARCH_EDIT = "Search: a2a authentication\nEvidence: any docs";

describe("parallel mutation ordering", () => {
  it("uses model order even when the later call runs first and the first fails", async () => {
    const calls = [edit("first"), edit("second")];
    const middleware = createFilesystemMiddleware();
    const request = (toolCall: ToolCall) =>
      ({
        toolCall,
        state: {
          messages: [new AIMessage({ content: "", tool_calls: calls })],
        },
      }) as FilesystemToolCallRequest;
    const handler = vi.fn(
      async ({ toolCall }: ToolCallRequest) =>
        new ToolMessage({
          content: "backend failed",
          tool_call_id: toolCall.id!,
          status: "error",
        }),
    );

    const later = await middleware.wrapToolCall!(request(calls[1]), handler);
    expect(later).toMatchObject({ status: "error", tool_call_id: "second" });
    expect(handler).not.toHaveBeenCalled();
    await middleware.wrapToolCall!(request(calls[0]), handler);
    await middleware.wrapToolCall!(request(calls[1]), handler);
    expect(handler).toHaveBeenCalledExactlyOnceWith(request(calls[0]));
  });

  it("leaves invalid paths to existing tool validation", async () => {
    const calls = [
      edit("first", "../prompt.md"),
      edit("second", "../prompt.md"),
    ];
    const middleware = createFilesystemMiddleware();
    const request = {
      toolCall: calls[1],
      state: { messages: [new AIMessage({ content: "", tool_calls: calls })] },
    } as FilesystemToolCallRequest;
    const result = new ToolMessage({
      content: "invalid path",
      tool_call_id: "second",
    });
    const handler = vi.fn().mockResolvedValue(result);

    expect(await middleware.wrapToolCall!(request, handler)).toBe(result);
    expect(handler).toHaveBeenCalledExactlyOnceWith(request);
  });
});

function edit(id: string, filePath = "/prompt.md"): ToolCall {
  return {
    id,
    name: "edit_file",
    args: {
      file_path: filePath,
      old_string: "Search: authentication",
      new_string: "Search: a2a authentication",
    },
  };
}

async function run(backend: "state" | "store", ...turns: ToolCall[][]) {
  const model = fakeModel();
  for (const tool_calls of turns) {
    model.respond(new AIMessage({ content: "", tool_calls }));
  }
  model.respond(new AIMessage("done"));
  const store = new InMemoryStore();
  const namespace = ["parallel-test"];
  const storeBackend = new StoreBackend({ store, namespace });
  const files = Object.fromEntries(
    ["/prompt.md", "/other.md"].map((path) => [path, createFileData(ORIGINAL)]),
  );
  if (backend === "store") {
    for (const path of Object.keys(files)) {
      await storeBackend.write(path, ORIGINAL);
    }
  }
  const agent = createAgent({
    model,
    middleware: [
      createFilesystemMiddleware({
        backend: backend === "store" ? storeBackend : undefined,
        toolTokenLimitBeforeEvict: null,
      }),
    ],
  });
  const result = await agent.invoke({
    messages: [new HumanMessage("edit")],
    files,
  });
  return {
    messages: result.messages.filter(ToolMessage.isInstance),
    content: async (path = "/prompt.md") => {
      const data =
        backend === "store"
          ? (await store.get(namespace, path))?.value
          : result.files?.[path];
      return data
        ? fileDataToString(data as ReturnType<typeof createFileData>)
        : undefined;
    },
  };
}

describe.each(["state", "store"] as const)(
  "parallel file mutations (%s)",
  (backend) => {
    it("preserves the first edit and rejects the later edit", async () => {
      const second = edit("second");
      second.args = {
        file_path: "/prompt.md",
        old_string: "Evidence: any docs",
        new_string: "Evidence: A2A docs only",
      };
      const { messages, content } = await run(backend, [edit("first"), second]);

      expect(messages[0].status).not.toBe("error");
      expect(messages[1]).toMatchObject({
        tool_call_id: "second",
        name: "edit_file",
        status: "error",
        content:
          "Error: parallel file mutations to the same path are not allowed.",
      });
      expect(await content()).toBe(SEARCH_EDIT);
    });

    it.each(["write_file", "delete"])(
      "rejects a later %s on the edited file",
      async (name) => {
        const { messages, content } = await run(backend, [
          edit("first"),
          {
            id: "second",
            name,
            args: { file_path: "/prompt.md", content: "overwrite" },
          },
        ]);

        expect(messages[1].status).toBe("error");
        expect(messages[1].content).toContain("parallel file mutations");
        expect(await content()).toBe(SEARCH_EDIT);
      },
    );

    it("allows edits to different files", async () => {
      const { messages, content } = await run(backend, [
        edit("first"),
        edit("second", "/other.md"),
      ]);

      expect(messages.every((message) => message.status !== "error")).toBe(
        true,
      );
      expect(await content()).toBe(SEARCH_EDIT);
      expect(await content("/other.md")).toBe(SEARCH_EDIT);
    });

    it("recognizes normalized paths and the supported path argument alias", async () => {
      const second = edit("second");
      second.args = { ...second.args, path: "/./prompt.md" };
      delete second.args.file_path;
      const { messages, content } = await run(backend, [edit("first"), second]);

      expect(messages[1].content).toContain("parallel file mutations");
      expect(await content()).toBe(SEARCH_EDIT);
    });

    it("does not treat reads as earlier mutations", async () => {
      const { messages, content } = await run(backend, [
        { id: "read", name: "read_file", args: { file_path: "/prompt.md" } },
        edit("first"),
      ]);

      expect(messages.every((message) => message.status !== "error")).toBe(
        true,
      );
      expect(await content()).toBe(SEARCH_EDIT);
    });

    it("allows the same file to be edited in a later model response", async () => {
      const second = edit("second");
      second.args.old_string = "Evidence: any docs";
      second.args.new_string = "Evidence: A2A docs only";
      const { messages, content } = await run(
        backend,
        [edit("first")],
        [second],
      );

      expect(messages.every((message) => message.status !== "error")).toBe(
        true,
      );
      expect(await content()).toBe(
        "Search: a2a authentication\nEvidence: A2A docs only",
      );
    });
  },
);
