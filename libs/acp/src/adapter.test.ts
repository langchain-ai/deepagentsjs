/**
 * Unit tests for the ACP <-> LangChain adapter functions
 */

import { describe, it, expect } from "vitest";
import { HumanMessage, AIMessage } from "@langchain/core/messages";
import type { ContentBlock } from "@agentclientprotocol/sdk";

import {
  acpContentToLangChain,
  acpPromptToHumanMessage,
  langChainContentToACP,
  langChainMessageToACP,
  extractToolCalls,
  todosToPlanEntries,
  generateSessionId,
  generateToolCallId,
  fileUriToPath,
  pathToFileUri,
  getToolCallKind,
  formatToolCallTitle,
  extractToolCallLocations,
} from "./adapter.js";

describe("acpContentToLangChain", () => {
  it("should convert single text block to string", () => {
    const content: ContentBlock[] = [{ type: "text", text: "Hello world" }];
    const result = acpContentToLangChain(content);
    expect(result).toBe("Hello world");
  });

  it("should convert multiple text blocks to array", () => {
    const content: ContentBlock[] = [
      { type: "text", text: "Hello" },
      { type: "text", text: "World" },
    ];
    const result = acpContentToLangChain(content);
    expect(result).toEqual([
      { type: "text", text: "Hello" },
      { type: "text", text: "World" },
    ]);
  });

  it("should convert image block with base64 data", () => {
    const content = [
      {
        type: "image",
        data: "base64encodeddata",
        mediaType: "image/jpeg",
      },
    ] as unknown as ContentBlock[];

    const result = acpContentToLangChain(content);
    expect(result).toEqual([
      {
        type: "image_url",
        image_url: "data:image/jpeg;base64,base64encodeddata",
      },
    ]);
  });

  it("should convert image block with URL", () => {
    const content = [
      {
        type: "image",
        url: "https://example.com/image.png",
      },
    ] as unknown as ContentBlock[];

    const result = acpContentToLangChain(content);
    expect(result).toEqual([
      {
        type: "image_url",
        image_url: "https://example.com/image.png",
      },
    ]);
  });

  it("should default to image/png for image without mediaType", () => {
    const content = [
      {
        type: "image",
        data: "somedata",
      },
    ] as unknown as ContentBlock[];

    const result = acpContentToLangChain(content);
    expect(result).toEqual([
      {
        type: "image_url",
        image_url: "data:image/png;base64,somedata",
      },
    ]);
  });

  it("should convert resource block to text", () => {
    const content = [
      {
        type: "resource",
        resource: {
          uri: "file:///path/to/file.txt",
          text: "File contents here",
        },
      },
    ] as unknown as ContentBlock[];

    const result = acpContentToLangChain(content);
    expect(result).toEqual([
      {
        type: "text",
        text: "[Resource: file:///path/to/file.txt]\nFile contents here",
      },
    ]);
  });

  it("should handle resource without uri or text", () => {
    const content = [
      {
        type: "resource",
        resource: {},
      },
    ] as unknown as ContentBlock[];

    const result = acpContentToLangChain(content);
    expect(result).toEqual([
      {
        type: "text",
        text: "[Resource: unknown]\n",
      },
    ]);
  });

  it("should handle unknown block types", () => {
    const content = [
      {
        type: "custom",
        data: "something",
      },
    ] as unknown as ContentBlock[];

    const result = acpContentToLangChain(content);
    expect(result).toHaveLength(1);
    expect((result as Array<{ type: string }>)[0].type).toBe("text");
  });

  it("should handle mixed content types", () => {
    const content = [
      { type: "text", text: "Check this image:" },
      {
        type: "image",
        url: "https://example.com/img.png",
      },
    ] as unknown as ContentBlock[];

    const result = acpContentToLangChain(content);
    expect(result).toHaveLength(2);
    expect((result as Array<{ type: string }>)[0]).toEqual({
      type: "text",
      text: "Check this image:",
    });
    expect((result as Array<{ type: string; image_url: string }>)[1]).toEqual({
      type: "image_url",
      image_url: "https://example.com/img.png",
    });
  });
});

describe("acpPromptToHumanMessage", () => {
  it("should create HumanMessage from text content", () => {
    const content: ContentBlock[] = [{ type: "text", text: "Hello assistant" }];
    const result = acpPromptToHumanMessage(content);

    expect(result).toBeInstanceOf(HumanMessage);
    expect(result.content).toBe("Hello assistant");
  });

  it("should create HumanMessage with array content for multiple blocks", () => {
    const content: ContentBlock[] = [
      { type: "text", text: "Part 1" },
      { type: "text", text: "Part 2" },
    ];
    const result = acpPromptToHumanMessage(content);

    expect(result).toBeInstanceOf(HumanMessage);
    expect(Array.isArray(result.content)).toBe(true);
  });
});

describe("langChainContentToACP", () => {
  it("should convert string content to text block", () => {
    const result = langChainContentToACP("Hello world");
    expect(result).toEqual([{ type: "text", text: "Hello world" }]);
  });

  it("should convert array of text blocks", () => {
    const content = [
      { type: "text", text: "Hello" },
      { type: "text", text: "World" },
    ];
    const result = langChainContentToACP(content);
    expect(result).toEqual([
      { type: "text", text: "Hello" },
      { type: "text", text: "World" },
    ]);
  });

  it("should convert non-text blocks to JSON string", () => {
    const content = [{ type: "image_url", image_url: "https://example.com" }];
    const result = langChainContentToACP(content);

    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("text");
    expect((result[0] as { text: string }).text).toContain("image_url");
  });
});

describe("langChainMessageToACP", () => {
  it("should convert AIMessage with string content", () => {
    const message = new AIMessage("I can help with that");
    const result = langChainMessageToACP(message);

    expect(result).toEqual([{ type: "text", text: "I can help with that" }]);
  });

  it("should convert HumanMessage with string content", () => {
    const message = new HumanMessage("Help me please");
    const result = langChainMessageToACP(message);

    expect(result).toEqual([{ type: "text", text: "Help me please" }]);
  });
});

describe("extractToolCalls", () => {
  it("should extract tool calls from AIMessage", () => {
    const message = new AIMessage({
      content: "Let me help",
      tool_calls: [
        {
          id: "call_123",
          name: "read_file",
          args: { path: "/test.txt" },
        },
      ],
    });

    const result = extractToolCalls(message);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      id: "call_123",
      name: "read_file",
      args: { path: "/test.txt" },
      status: "pending",
    });
  });

  it("should handle multiple tool calls", () => {
    const message = new AIMessage({
      content: "",
      tool_calls: [
        { id: "call_1", name: "ls", args: { path: "/" } },
        { id: "call_2", name: "grep", args: { pattern: "TODO" } },
      ],
    });

    const result = extractToolCalls(message);

    expect(result).toHaveLength(2);
    expect(result[0].name).toBe("ls");
    expect(result[1].name).toBe("grep");
  });

  it("should return empty array when no tool calls", () => {
    const message = new AIMessage("Just text");
    const result = extractToolCalls(message);

    expect(result).toEqual([]);
  });

  it("should generate ID for tool calls without ID", () => {
    const message = new AIMessage({
      content: "",
      tool_calls: [{ name: "test", args: {} }],
    });

    const result = extractToolCalls(message);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBeDefined();
    expect(result[0].id.length).toBeGreaterThan(0);
  });
});

describe("todosToPlanEntries", () => {
  it("should convert todos to plan entries", () => {
    const todos = [
      { id: "1", content: "Task 1", status: "pending" as const },
      { id: "2", content: "Task 2", status: "in_progress" as const },
      { id: "3", content: "Task 3", status: "completed" as const },
    ];

    const result = todosToPlanEntries(todos);

    expect(result).toEqual([
      { content: "Task 1", priority: "medium", status: "pending" },
      { content: "Task 2", priority: "medium", status: "in_progress" },
      { content: "Task 3", priority: "medium", status: "completed" },
    ]);
  });

  it("should convert cancelled to skipped", () => {
    const todos = [
      { id: "1", content: "Cancelled task", status: "cancelled" as const },
    ];

    const result = todosToPlanEntries(todos);

    expect(result[0].status).toBe("skipped");
  });

  it("should preserve priority when provided", () => {
    const todos = [
      {
        id: "1",
        content: "High priority",
        status: "pending" as const,
        priority: "high",
      },
      {
        id: "2",
        content: "Low priority",
        status: "pending" as const,
        priority: "low",
      },
    ];

    const result = todosToPlanEntries(todos);

    expect(result[0].priority).toBe("high");
    expect(result[1].priority).toBe("low");
  });

  it("should handle empty todos array", () => {
    const result = todosToPlanEntries([]);
    expect(result).toEqual([]);
  });
});

describe("generateSessionId", () => {
  it("should generate unique session IDs", () => {
    const id1 = generateSessionId();
    const id2 = generateSessionId();

    expect(id1).not.toBe(id2);
  });

  it("should start with sess_ prefix", () => {
    const id = generateSessionId();
    expect(id).toMatch(/^sess_/);
  });

  it("should have correct length", () => {
    const id = generateSessionId();
    // "sess_" (5) + 16 hex chars = 21
    expect(id).toHaveLength(21);
  });
});

describe("generateToolCallId", () => {
  it("should generate unique tool call IDs", () => {
    const id1 = generateToolCallId();
    const id2 = generateToolCallId();

    expect(id1).not.toBe(id2);
  });

  it("should start with call_ prefix", () => {
    const id = generateToolCallId();
    expect(id).toMatch(/^call_/);
  });

  it("should have correct length", () => {
    const id = generateToolCallId();
    // "call_" (5) + 12 hex chars = 17
    expect(id).toHaveLength(17);
  });
});

describe("fileUriToPath", () => {
  it("should remove file:// prefix", () => {
    const result = fileUriToPath("file:///path/to/file.txt");
    expect(result).toBe("/path/to/file.txt");
  });

  it("should return path as-is if no file:// prefix", () => {
    const result = fileUriToPath("/path/to/file.txt");
    expect(result).toBe("/path/to/file.txt");
  });

  it("should handle relative paths", () => {
    const result = fileUriToPath("./relative/path.txt");
    expect(result).toBe("./relative/path.txt");
  });
});

describe("pathToFileUri", () => {
  it("should add file:// prefix", () => {
    const result = pathToFileUri("/path/to/file.txt");
    expect(result).toBe("file:///path/to/file.txt");
  });

  it("should not double-prefix", () => {
    const result = pathToFileUri("file:///path/to/file.txt");
    expect(result).toBe("file:///path/to/file.txt");
  });
});

describe("getToolCallKind", () => {
  it("should identify read tools", () => {
    expect(getToolCallKind("read_file")).toBe("read");
    expect(getToolCallKind("ls")).toBe("read");
  });

  it("should identify search tools", () => {
    expect(getToolCallKind("grep")).toBe("search");
    expect(getToolCallKind("glob")).toBe("search");
  });

  it("should identify edit tools", () => {
    expect(getToolCallKind("write_file")).toBe("edit");
    expect(getToolCallKind("edit_file")).toBe("edit");
  });

  it("should identify execute tools", () => {
    expect(getToolCallKind("execute")).toBe("execute");
    expect(getToolCallKind("shell")).toBe("execute");
    expect(getToolCallKind("terminal")).toBe("execute");
  });

  it("should identify think tools", () => {
    expect(getToolCallKind("write_todos")).toBe("think");
  });

  it("should return other for unknown tools", () => {
    expect(getToolCallKind("custom_tool")).toBe("other");
    expect(getToolCallKind("unknown")).toBe("other");
  });
});

describe("formatToolCallTitle", () => {
  it("should format read_file title", () => {
    const result = formatToolCallTitle("read_file", { path: "/src/index.ts" });
    expect(result).toBe("Reading /src/index.ts");
  });

  it("should format write_file title", () => {
    const result = formatToolCallTitle("write_file", { path: "/output.txt" });
    expect(result).toBe("Writing /output.txt");
  });

  it("should format edit_file title", () => {
    const result = formatToolCallTitle("edit_file", { path: "/config.json" });
    expect(result).toBe("Editing /config.json");
  });

  it("should format ls title", () => {
    const result = formatToolCallTitle("ls", { path: "/src" });
    expect(result).toBe("Listing /src");
  });

  it("should format grep title", () => {
    const result = formatToolCallTitle("grep", { pattern: "TODO" });
    expect(result).toBe('Searching for "TODO"');
  });

  it("should format glob title", () => {
    const result = formatToolCallTitle("glob", { pattern: "*.ts" });
    expect(result).toBe("Finding files matching *.ts");
  });

  it("should format task title", () => {
    const result = formatToolCallTitle("task", { description: "Run tests" });
    expect(result).toBe("Delegating: Run tests");
  });

  it("should format unknown tool title", () => {
    const result = formatToolCallTitle("custom_tool", { foo: "bar" });
    expect(result).toBe("Executing custom_tool");
  });

  it("should handle missing args gracefully", () => {
    expect(formatToolCallTitle("read_file", {})).toBe("Reading file");
    expect(formatToolCallTitle("ls", {})).toBe("Listing directory");
    expect(formatToolCallTitle("grep", {})).toBe('Searching for "pattern"');
    expect(formatToolCallTitle("task", {})).toBe("Delegating: subtask");
  });

  it("should format write_todos title", () => {
    const result = formatToolCallTitle("write_todos", {});
    expect(result).toBe("Planning tasks");
  });
});

describe("extractToolCallLocations", () => {
  it("should extract location for read_file with absolute path", () => {
    const result = extractToolCallLocations(
      "read_file",
      { path: "/src/index.ts" },
      "/workspace",
    );
    expect(result).toEqual([{ path: "/src/index.ts" }]);
  });

  it("should resolve relative path using workspace root", () => {
    const result = extractToolCallLocations(
      "read_file",
      { path: "src/index.ts" },
      "/workspace",
    );
    expect(result).toEqual([{ path: "/workspace/src/index.ts" }]);
  });

  it("should include line number when present", () => {
    const result = extractToolCallLocations(
      "read_file",
      { path: "/src/file.ts", line: 42 },
      "/workspace",
    );
    expect(result).toEqual([{ path: "/src/file.ts", line: 42 }]);
  });

  it("should include startLine as line when present", () => {
    const result = extractToolCallLocations(
      "edit_file",
      { path: "/src/file.ts", startLine: 10 },
      "/workspace",
    );
    expect(result).toEqual([{ path: "/src/file.ts", line: 10 }]);
  });

  it("should return undefined for tools without path arg", () => {
    const result = extractToolCallLocations(
      "grep",
      { pattern: "TODO" },
      "/workspace",
    );
    expect(result).toBeUndefined();
  });

  it("should return undefined for non-file tools", () => {
    const result = extractToolCallLocations(
      "task",
      { path: "/something", description: "do stuff" },
      "/workspace",
    );
    expect(result).toBeUndefined();
  });

  it("should handle all supported file tools", () => {
    const tools = [
      "read_file",
      "write_file",
      "edit_file",
      "ls",
      "grep",
      "glob",
    ];
    for (const tool of tools) {
      const result = extractToolCallLocations(
        tool,
        { path: "/test.txt" },
        "/ws",
      );
      expect(result).toBeDefined();
      expect(result![0].path).toBe("/test.txt");
    }
  });

  it("should handle missing workspace root for relative paths", () => {
    const result = extractToolCallLocations("read_file", { path: "file.ts" });
    expect(result).toEqual([{ path: "/file.ts" }]);
  });
});
