import { describe, it, expect, vi } from "vitest";
import {
  fileDataReducer,
  type FilesRecord,
  type FilesRecordUpdate,
  createFilesystemMiddleware,
  NUM_CHARS_PER_TOKEN,
  TOOLS_EXCLUDED_FROM_EVICTION,
} from "./fs.js";
import type { FileData, BackendProtocol } from "../backends/protocol.js";
import { SystemMessage } from "@langchain/core/messages";
import { ToolMessage } from "langchain";
import { Command, isCommand } from "@langchain/langgraph";

describe("fileDataReducer", () => {
  // Helper to create a FileData object
  function createFileData(
    content: string[],
    createdAt = "2024-01-01T00:00:00Z",
    modifiedAt = "2024-01-01T00:00:00Z",
  ): FileData {
    return {
      content,
      created_at: createdAt,
      modified_at: modifiedAt,
    };
  }

  describe("edge cases", () => {
    it("should return empty object when both current and update are undefined", () => {
      const result = fileDataReducer(undefined, undefined);
      expect(result).toEqual({});
    });

    it("should return current when update is undefined", () => {
      const current: FilesRecord = {
        "/file.txt": createFileData(["hello"]),
      };
      const result = fileDataReducer(current, undefined);
      expect(result).toEqual(current);
    });

    it("should return empty object when current is undefined and update is empty", () => {
      const result = fileDataReducer(undefined, {});
      expect(result).toEqual({});
    });

    it("should filter out null values when current is undefined", () => {
      const update: FilesRecordUpdate = {
        "/file.txt": createFileData(["hello"]),
        "/deleted.txt": null,
      };
      const result = fileDataReducer(undefined, update);
      expect(result).toEqual({
        "/file.txt": createFileData(["hello"]),
      });
    });
  });

  describe("adding files", () => {
    it("should add new files to empty state", () => {
      const update: FilesRecordUpdate = {
        "/new-file.txt": createFileData(["new content"]),
      };
      const result = fileDataReducer({}, update);
      expect(result).toEqual({
        "/new-file.txt": createFileData(["new content"]),
      });
    });

    it("should add new files to existing state", () => {
      const current: FilesRecord = {
        "/existing.txt": createFileData(["existing"]),
      };
      const update: FilesRecordUpdate = {
        "/new-file.txt": createFileData(["new content"]),
      };
      const result = fileDataReducer(current, update);
      expect(result).toEqual({
        "/existing.txt": createFileData(["existing"]),
        "/new-file.txt": createFileData(["new content"]),
      });
    });

    it("should add multiple files at once", () => {
      const current: FilesRecord = {
        "/existing.txt": createFileData(["existing"]),
      };
      const update: FilesRecordUpdate = {
        "/file1.txt": createFileData(["content 1"]),
        "/file2.txt": createFileData(["content 2"]),
        "/file3.txt": createFileData(["content 3"]),
      };
      const result = fileDataReducer(current, update);
      expect(Object.keys(result)).toHaveLength(4);
      expect(result["/file1.txt"]).toEqual(createFileData(["content 1"]));
      expect(result["/file2.txt"]).toEqual(createFileData(["content 2"]));
      expect(result["/file3.txt"]).toEqual(createFileData(["content 3"]));
    });
  });

  describe("updating files", () => {
    it("should update existing file content", () => {
      const current: FilesRecord = {
        "/file.txt": createFileData(["old content"], "2024-01-01T00:00:00Z"),
      };
      const update: FilesRecordUpdate = {
        "/file.txt": createFileData(["new content"], "2024-01-02T00:00:00Z"),
      };
      const result = fileDataReducer(current, update);
      expect(result["/file.txt"].content).toEqual(["new content"]);
      expect(result["/file.txt"].created_at).toBe("2024-01-02T00:00:00Z");
    });

    it("should update only the modified files", () => {
      const current: FilesRecord = {
        "/file1.txt": createFileData(["content 1"]),
        "/file2.txt": createFileData(["content 2"]),
        "/file3.txt": createFileData(["content 3"]),
      };
      const update: FilesRecordUpdate = {
        "/file2.txt": createFileData(["updated content 2"]),
      };
      const result = fileDataReducer(current, update);
      expect(result["/file1.txt"].content).toEqual(["content 1"]);
      expect(result["/file2.txt"].content).toEqual(["updated content 2"]);
      expect(result["/file3.txt"].content).toEqual(["content 3"]);
    });
  });

  describe("deleting files", () => {
    it("should delete a file when value is null", () => {
      const current: FilesRecord = {
        "/file.txt": createFileData(["content"]),
        "/keep.txt": createFileData(["keep this"]),
      };
      const update: FilesRecordUpdate = {
        "/file.txt": null,
      };
      const result = fileDataReducer(current, update);
      expect(result).toEqual({
        "/keep.txt": createFileData(["keep this"]),
      });
      expect("/file.txt" in result).toBe(false);
    });

    it("should delete multiple files at once", () => {
      const current: FilesRecord = {
        "/file1.txt": createFileData(["content 1"]),
        "/file2.txt": createFileData(["content 2"]),
        "/file3.txt": createFileData(["content 3"]),
        "/keep.txt": createFileData(["keep"]),
      };
      const update: FilesRecordUpdate = {
        "/file1.txt": null,
        "/file3.txt": null,
      };
      const result = fileDataReducer(current, update);
      expect(Object.keys(result)).toHaveLength(2);
      expect(result["/file2.txt"]).toBeDefined();
      expect(result["/keep.txt"]).toBeDefined();
    });

    it("should handle deletion of non-existent file gracefully", () => {
      const current: FilesRecord = {
        "/file.txt": createFileData(["content"]),
      };
      const update: FilesRecordUpdate = {
        "/non-existent.txt": null,
      };
      const result = fileDataReducer(current, update);
      expect(result).toEqual({
        "/file.txt": createFileData(["content"]),
      });
    });
  });

  describe("mixed operations", () => {
    it("should handle add, update, and delete in single update", () => {
      const current: FilesRecord = {
        "/existing.txt": createFileData(["existing"]),
        "/to-update.txt": createFileData(["old"]),
        "/to-delete.txt": createFileData(["will be deleted"]),
      };
      const update: FilesRecordUpdate = {
        "/new-file.txt": createFileData(["new"]),
        "/to-update.txt": createFileData(["updated"]),
        "/to-delete.txt": null,
      };
      const result = fileDataReducer(current, update);
      expect(Object.keys(result).sort()).toEqual([
        "/existing.txt",
        "/new-file.txt",
        "/to-update.txt",
      ]);
      expect(result["/existing.txt"].content).toEqual(["existing"]);
      expect(result["/new-file.txt"].content).toEqual(["new"]);
      expect(result["/to-update.txt"].content).toEqual(["updated"]);
    });
  });

  describe("parallel subagent simulation", () => {
    it("should handle concurrent file updates from multiple parallel subagents", () => {
      // Simulate: main agent has some files, two subagents run in parallel
      const mainAgentFiles: FilesRecord = {
        "/shared.txt": createFileData(["main agent version"]),
        "/main-only.txt": createFileData(["only in main"]),
      };

      // First subagent creates and modifies files
      const subagent1Update: FilesRecordUpdate = {
        "/shared.txt": createFileData(["subagent 1 version"]),
        "/subagent1.txt": createFileData(["from subagent 1"]),
      };

      // Second subagent creates and modifies files
      const subagent2Update: FilesRecordUpdate = {
        "/shared.txt": createFileData(["subagent 2 version"]),
        "/subagent2.txt": createFileData(["from subagent 2"]),
      };

      // Apply updates sequentially (as the reducer would be called)
      const afterSubagent1 = fileDataReducer(mainAgentFiles, subagent1Update);
      const afterSubagent2 = fileDataReducer(afterSubagent1, subagent2Update);

      expect(Object.keys(afterSubagent2).sort()).toEqual([
        "/main-only.txt",
        "/shared.txt",
        "/subagent1.txt",
        "/subagent2.txt",
      ]);

      // Last update wins for shared file
      expect(afterSubagent2["/shared.txt"].content).toEqual([
        "subagent 2 version",
      ]);
    });

    it("should handle one subagent adding and another deleting the same file", () => {
      const current: FilesRecord = {
        "/existing.txt": createFileData(["existing"]),
      };

      // First subagent adds a file
      const subagent1Update: FilesRecordUpdate = {
        "/new-file.txt": createFileData(["created by subagent 1"]),
      };

      // Second subagent deletes that same file (e.g., cleanup operation)
      const subagent2Update: FilesRecordUpdate = {
        "/new-file.txt": null,
      };

      const afterSubagent1 = fileDataReducer(current, subagent1Update);
      expect(afterSubagent1["/new-file.txt"]).toBeDefined();

      const afterSubagent2 = fileDataReducer(afterSubagent1, subagent2Update);
      expect("/new-file.txt" in afterSubagent2).toBe(false);
    });

    it("should preserve file metadata through merges", () => {
      const current: FilesRecord = {
        "/file.txt": {
          content: ["line 1", "line 2", "line 3"],
          created_at: "2024-01-01T00:00:00Z",
          modified_at: "2024-01-01T12:00:00Z",
        },
      };

      const update: FilesRecordUpdate = {
        "/file.txt": {
          content: ["updated line 1", "updated line 2"],
          created_at: "2024-01-02T00:00:00Z",
          modified_at: "2024-01-02T12:00:00Z",
        },
      };

      const result = fileDataReducer(current, update);

      expect(result["/file.txt"]).toEqual(update["/file.txt"]);
      expect(result["/file.txt"].content).toEqual([
        "updated line 1",
        "updated line 2",
      ]);
      expect(result["/file.txt"].created_at).toBe("2024-01-02T00:00:00Z");
      expect(result["/file.txt"].modified_at).toBe("2024-01-02T12:00:00Z");
    });
  });

  describe("immutability", () => {
    it("should not mutate the current state", () => {
      const current: FilesRecord = {
        "/file.txt": createFileData(["original"]),
      };
      const originalCurrent = JSON.parse(JSON.stringify(current));

      const update: FilesRecordUpdate = {
        "/file.txt": createFileData(["updated"]),
        "/new.txt": createFileData(["new"]),
      };

      fileDataReducer(current, update);

      expect(current).toEqual(originalCurrent);
    });

    it("should return a new object reference", () => {
      const current: FilesRecord = {
        "/file.txt": createFileData(["content"]),
      };
      const update: FilesRecordUpdate = {
        "/new.txt": createFileData(["new"]),
      };

      const result = fileDataReducer(current, update);

      expect(result).not.toBe(current);
    });
  });
});

describe("createFilesystemMiddleware", () => {
  // Helper to create a mock backend that doesn't support execution
  function createMockBackend(): BackendProtocol {
    return {
      lsInfo: vi.fn().mockResolvedValue([]),
      read: vi.fn().mockResolvedValue(""),
      write: vi.fn().mockResolvedValue({ error: null, filesUpdate: null }),
      edit: vi.fn().mockResolvedValue({
        error: null,
        occurrences: 1,
        filesUpdate: null,
      }),
      globInfo: vi.fn().mockResolvedValue([]),
      grepRaw: vi.fn().mockResolvedValue([]),
    } as unknown as BackendProtocol;
  }

  // Helper to create a mock backend that supports execution (SandboxBackendProtocol)
  function createMockSandboxBackend(): BackendProtocol {
    return {
      ...createMockBackend(),
      id: "mock-sandbox",
      execute: vi.fn().mockResolvedValue({
        output: "command output",
        exitCode: 0,
        truncated: false,
      }),
    } as unknown as BackendProtocol;
  }

  describe("wrapModelCall", () => {
    it("should add filesystem system prompt to model call", () => {
      const middleware = createFilesystemMiddleware({
        backend: createMockBackend(),
      });

      const mockHandler = vi.fn().mockReturnValue({ response: "ok" });
      const request = {
        systemMessage: new SystemMessage("Base prompt"),
        state: {},
        config: {},
        tools: middleware.tools || [],
      };

      middleware.wrapModelCall!(request as any, mockHandler);

      expect(mockHandler).toHaveBeenCalled();
      const modifiedRequest = mockHandler.mock.calls[0][0];
      expect(modifiedRequest.systemMessage.text).toContain("Filesystem Tools");
      expect(modifiedRequest.systemMessage.text).toContain("Base prompt");
    });

    it("should include execute tool and execution prompt when backend supports execution", () => {
      const middleware = createFilesystemMiddleware({
        backend: createMockSandboxBackend(),
      });

      const mockHandler = vi.fn().mockReturnValue({ response: "ok" });
      const request = {
        systemMessage: new SystemMessage("Base prompt"),
        state: {},
        config: {},
        tools: middleware.tools || [],
      };

      middleware.wrapModelCall!(request as any, mockHandler);

      expect(mockHandler).toHaveBeenCalled();
      const modifiedRequest = mockHandler.mock.calls[0][0];

      // Should include execution system prompt
      expect(modifiedRequest.systemMessage.text).toContain("Execute Tool");
      expect(modifiedRequest.systemMessage.text).toContain("Base prompt");

      // Should include execute tool in tools array
      const toolNames = modifiedRequest.tools.map((t: any) => t.name);
      expect(toolNames).toContain("execute");
    });

    it("should exclude execute tool when backend doesn't support execution", () => {
      const middleware = createFilesystemMiddleware({
        backend: createMockBackend(),
      });

      const mockHandler = vi.fn().mockReturnValue({ response: "ok" });
      const request = {
        systemMessage: new SystemMessage("Base prompt"),
        state: {},
        config: {},
        tools: middleware.tools || [],
      };

      middleware.wrapModelCall!(request as any, mockHandler);

      expect(mockHandler).toHaveBeenCalled();
      const modifiedRequest = mockHandler.mock.calls[0][0];

      // Should NOT include execution system prompt
      expect(modifiedRequest.systemMessage.text).not.toContain("Execute Tool");

      // Should NOT include execute tool in tools array
      const toolNames = modifiedRequest.tools.map((t: any) => t.name);
      expect(toolNames).not.toContain("execute");
    });

    it("should use custom system prompt when provided", () => {
      const customPrompt = "Custom filesystem instructions";
      const middleware = createFilesystemMiddleware({
        backend: createMockBackend(),
        systemPrompt: customPrompt,
      });

      const mockHandler = vi.fn().mockReturnValue({ response: "ok" });
      const request = {
        systemMessage: new SystemMessage("Base prompt"),
        state: {},
        config: {},
        tools: middleware.tools || [],
      };

      middleware.wrapModelCall!(request as any, mockHandler);

      expect(mockHandler).toHaveBeenCalled();
      const modifiedRequest = mockHandler.mock.calls[0][0];

      // Should include custom prompt
      expect(modifiedRequest.systemMessage.text).toContain(customPrompt);
      // Should NOT include default filesystem prompt
      expect(modifiedRequest.systemMessage.text).not.toContain(
        "Filesystem Tools",
      );
    });
  });

  describe("wrapToolCall", () => {
    it("should pass through handler when eviction is disabled", async () => {
      const middleware = createFilesystemMiddleware({
        backend: createMockBackend(),
        toolTokenLimitBeforeEvict: null,
      });

      const mockMessage = new ToolMessage({
        content: "test result",
        tool_call_id: "test-id",
        name: "test_tool",
      });
      const mockHandler = vi.fn().mockResolvedValue(mockMessage);
      const request = {
        toolCall: { id: "test-id", name: "test_tool" },
        state: {},
        config: {},
      };

      const result = await middleware.wrapToolCall!(
        request as any,
        mockHandler,
      );

      expect(mockHandler).toHaveBeenCalledWith(request);
      expect(result).toBe(mockMessage);
    });

    it("should not evict tools in TOOLS_EXCLUDED_FROM_EVICTION even with large results", async () => {
      const middleware = createFilesystemMiddleware({
        backend: createMockBackend(),
        toolTokenLimitBeforeEvict: 100,
      });

      // Create large content that would normally trigger eviction
      const largeContent = "x".repeat(100 * NUM_CHARS_PER_TOKEN + 1000);

      // Test a representative excluded tool
      const toolName = TOOLS_EXCLUDED_FROM_EVICTION[0];
      const mockMessage = new ToolMessage({
        content: largeContent,
        tool_call_id: "test-id",
        name: toolName,
      });
      const mockHandler = vi.fn().mockResolvedValue(mockMessage);
      const request = {
        toolCall: { id: "test-id", name: toolName },
        state: {},
        config: {},
      };

      const result = await middleware.wrapToolCall!(
        request as any,
        mockHandler,
      );

      // Should not be evicted - should return original message
      expect(result).toBe(mockMessage);
      expect(ToolMessage.isInstance(result)).toBe(true);
      if (ToolMessage.isInstance(result)) {
        expect(result.content).toBe(largeContent);
        expect(result.content).not.toContain("Tool result too large");
      }
    });

    it("should not evict small ToolMessage results", async () => {
      const middleware = createFilesystemMiddleware({
        backend: createMockBackend(),
        toolTokenLimitBeforeEvict: 1000,
      });

      const smallContent = "This is a small result";
      const mockMessage = new ToolMessage({
        content: smallContent,
        tool_call_id: "test-id",
        name: "some_tool",
      });
      const mockHandler = vi.fn().mockResolvedValue(mockMessage);
      const request = {
        toolCall: { id: "test-id", name: "some_tool" },
        state: {},
        config: {},
      };

      const result = await middleware.wrapToolCall!(
        request as any,
        mockHandler,
      );

      expect(ToolMessage.isInstance(result)).toBe(true);
      if (ToolMessage.isInstance(result)) {
        expect(result.content).toBe(smallContent);
        expect(result.tool_call_id).toBe("test-id");
      }
    });

    it("should evict large ToolMessage results to filesystem", async () => {
      const mockBackend = createMockBackend();
      const mockWrite = vi.fn().mockResolvedValue({
        error: null,
        filesUpdate: {
          "/large_tool_results/test-id": {
            content: ["large content"],
            created_at: "2024-01-01T00:00:00Z",
            modified_at: "2024-01-01T00:00:00Z",
          },
        },
      });
      mockBackend.write = mockWrite;

      const middleware = createFilesystemMiddleware({
        backend: mockBackend,
        toolTokenLimitBeforeEvict: 100,
      });

      const largeContent = "x".repeat(100 * NUM_CHARS_PER_TOKEN + 1000);
      const mockMessage = new ToolMessage({
        content: largeContent,
        tool_call_id: "test-id",
        name: "some_tool",
      });
      const mockHandler = vi.fn().mockResolvedValue(mockMessage);
      const request = {
        toolCall: { id: "test-id", name: "some_tool" },
        state: {},
        config: {},
      };

      const result = await middleware.wrapToolCall!(
        request as any,
        mockHandler,
      );

      // Should have written to backend
      expect(mockWrite).toHaveBeenCalledWith(
        "/large_tool_results/test-id",
        largeContent,
      );

      // Should return a Command with truncated message
      expect(isCommand(result)).toBe(true);
      if (isCommand(result)) {
        const update = result.update as any;
        expect(update.messages).toHaveLength(1);
        expect(ToolMessage.isInstance(update.messages[0])).toBe(true);

        const truncatedMsg = update.messages[0];
        expect(truncatedMsg.content).toContain("Tool result too large");
        expect(truncatedMsg.content).toContain("/large_tool_results/test-id");
        expect(truncatedMsg.tool_call_id).toBe("test-id");

        // Should have filesUpdate
        expect(update.files).toBeDefined();
        expect(update.files["/large_tool_results/test-id"]).toBeDefined();
      }
    });

    it("should handle Command with multiple ToolMessages", async () => {
      const mockBackend = createMockBackend();
      const mockWrite = vi.fn().mockResolvedValue({
        error: null,
        filesUpdate: {
          "/large_tool_results/test-id-1": {
            content: ["large content 1"],
            created_at: "2024-01-01T00:00:00Z",
            modified_at: "2024-01-01T00:00:00Z",
          },
        },
      });
      mockBackend.write = mockWrite;

      const middleware = createFilesystemMiddleware({
        backend: mockBackend,
        toolTokenLimitBeforeEvict: 100,
      });

      const largeContent = "y".repeat(100 * NUM_CHARS_PER_TOKEN + 1000);
      const smallContent = "small result";

      const largeMessage = new ToolMessage({
        content: largeContent,
        tool_call_id: "test-id-1",
        name: "tool1",
      });

      const smallMessage = new ToolMessage({
        content: smallContent,
        tool_call_id: "test-id-2",
        name: "tool2",
      });

      const commandResult = new Command({
        update: {
          messages: [largeMessage, smallMessage],
          files: {},
        },
      });

      const mockHandler = vi.fn().mockResolvedValue(commandResult);
      const request = {
        toolCall: { id: "test-id-1", name: "tool1" },
        state: {},
        config: {},
      };

      const result = await middleware.wrapToolCall!(
        request as any,
        mockHandler,
      );

      // Should have written large content
      expect(mockWrite).toHaveBeenCalledWith(
        "/large_tool_results/test-id-1",
        largeContent,
      );

      // Result should be a Command
      expect(isCommand(result)).toBe(true);
      if (isCommand(result)) {
        const update = result.update as any;
        expect(update.messages).toHaveLength(2);

        // First message should be truncated
        expect(update.messages[0].content).toContain("Tool result too large");

        // Second message should be unchanged
        expect(update.messages[1].content).toBe(smallContent);

        // Should accumulate files
        expect(update.files["/large_tool_results/test-id-1"]).toBeDefined();
      }
    });

    it("should handle write errors gracefully during eviction", async () => {
      const mockBackend = createMockBackend();
      const mockWrite = vi.fn().mockResolvedValue({
        error: "Failed to write file",
        filesUpdate: null,
      });
      mockBackend.write = mockWrite;

      const middleware = createFilesystemMiddleware({
        backend: mockBackend,
        toolTokenLimitBeforeEvict: 100,
      });

      const largeContent = "z".repeat(100 * NUM_CHARS_PER_TOKEN + 1000);
      const mockMessage = new ToolMessage({
        content: largeContent,
        tool_call_id: "test-id",
        name: "some_tool",
      });
      const mockHandler = vi.fn().mockResolvedValue(mockMessage);
      const request = {
        toolCall: { id: "test-id", name: "some_tool" },
        state: {},
        config: {},
      };

      const result = await middleware.wrapToolCall!(
        request as any,
        mockHandler,
      );

      // Should attempt to write
      expect(mockWrite).toHaveBeenCalled();

      // Should return original message when write fails
      expect(ToolMessage.isInstance(result)).toBe(true);
      if (ToolMessage.isInstance(result)) {
        expect(result.content).toBe(largeContent);
      }
    });
  });

  describe("tools", () => {
    it("write_file schema should accept missing content and default to empty string", () => {
      const middleware = createFilesystemMiddleware({
        backend: createMockBackend(),
      });

      const writeFileTool = middleware.tools!.find(
        (t: any) => t.name === "write_file",
      ) as any;
      expect(writeFileTool).toBeDefined();

      // Parse with only file_path, no content — simulates the model omitting it
      const parsed = writeFileTool.schema.parse({ file_path: "/app/test.c" });
      expect(parsed.file_path).toBe("/app/test.c");
      expect(parsed.content).toBe("");
    });
  });
});
