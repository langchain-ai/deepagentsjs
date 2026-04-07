import { describe, it, expect, vi, beforeEach } from "vitest";
import { getCurrentTaskInput } from "@langchain/langgraph";
import type { StructuredTool } from "langchain";

import {
  createContentPreview,
  createFilesystemMiddleware,
  TOOLS_EXCLUDED_FROM_EVICTION,
  NUM_CHARS_PER_TOKEN,
  MAX_BINARY_READ_SIZE_BYTES,
} from "./fs.js";
import { StateBackend } from "../backends/state.js";
import type { FileData } from "../backends/protocol.js";

vi.mock("@langchain/langgraph", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...(actual as any),
    getCurrentTaskInput: vi.fn(),
  };
});

describe("TOOLS_EXCLUDED_FROM_EVICTION", () => {
  it("should contain the expected tools", () => {
    expect(TOOLS_EXCLUDED_FROM_EVICTION).toContain("ls");
    expect(TOOLS_EXCLUDED_FROM_EVICTION).toContain("glob");
    expect(TOOLS_EXCLUDED_FROM_EVICTION).toContain("grep");
    expect(TOOLS_EXCLUDED_FROM_EVICTION).toContain("read_file");
    expect(TOOLS_EXCLUDED_FROM_EVICTION).toContain("edit_file");
    expect(TOOLS_EXCLUDED_FROM_EVICTION).toContain("write_file");
  });

  it("should not contain execute tool", () => {
    expect(TOOLS_EXCLUDED_FROM_EVICTION).not.toContain("execute");
  });

  it("should be a readonly array", () => {
    // This is a type-level check, but we can verify it's an array
    expect(Array.isArray(TOOLS_EXCLUDED_FROM_EVICTION)).toBe(true);
    expect(TOOLS_EXCLUDED_FROM_EVICTION.length).toBe(6);
  });
});

describe("NUM_CHARS_PER_TOKEN", () => {
  it("should be 4", () => {
    expect(NUM_CHARS_PER_TOKEN).toBe(4);
  });
});

describe("createContentPreview", () => {
  it("should show all lines for small content", () => {
    const content = "line1\nline2\nline3";
    const preview = createContentPreview(content, 5, 5);

    expect(preview).toContain("line1");
    expect(preview).toContain("line2");
    expect(preview).toContain("line3");
    expect(preview).not.toContain("truncated");
  });

  it("should show head and tail with truncation marker for large content", () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line${i + 1}`);
    const content = lines.join("\n");
    const preview = createContentPreview(content, 5, 5);

    // Should contain head lines
    expect(preview).toContain("line1");
    expect(preview).toContain("line5");

    // Should contain truncation marker
    expect(preview).toContain("truncated");
    expect(preview).toContain("10 lines truncated");

    // Should contain tail lines
    expect(preview).toContain("line16");
    expect(preview).toContain("line20");
  });

  it("should use default head/tail values", () => {
    const lines = Array.from({ length: 15 }, (_, i) => `line${i + 1}`);
    const content = lines.join("\n");
    const preview = createContentPreview(content);

    // Default is 5 head + 5 tail = 10, so 15 lines should show truncation
    expect(preview).toContain("truncated");
    expect(preview).toContain("5 lines truncated");
  });

  it("should truncate long lines to 1000 chars", () => {
    const longLine = "x".repeat(2000);
    const content = longLine;
    const preview = createContentPreview(content, 5, 5);

    // Should be truncated
    expect(preview.length).toBeLessThan(2000);
  });

  it("should include line numbers", () => {
    const content = "line1\nline2\nline3";
    const preview = createContentPreview(content);

    // Line numbers are right-padded with tab
    expect(preview).toMatch(/\d+\s+line1/);
    expect(preview).toMatch(/\d+\s+line2/);
    expect(preview).toMatch(/\d+\s+line3/);
  });

  it("should handle custom head and tail sizes", () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line${i + 1}`);
    const content = lines.join("\n");
    const preview = createContentPreview(content, 3, 3);

    // Head should have 3 lines
    expect(preview).toContain("line1");
    expect(preview).toContain("line3");

    // Truncation should show 24 lines
    expect(preview).toContain("24 lines truncated");

    // Tail should have 3 lines
    expect(preview).toContain("line28");
    expect(preview).toContain("line30");
  });

  it("should handle exactly head + tail lines", () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line${i + 1}`);
    const content = lines.join("\n");
    const preview = createContentPreview(content, 5, 5);

    // Should show all lines without truncation
    expect(preview).not.toContain("truncated");
    expect(preview).toContain("line1");
    expect(preview).toContain("line10");
  });

  it("should handle empty content", () => {
    const preview = createContentPreview("");
    // Empty string splits into a single empty line, which gets formatted with a line number
    expect(preview).toContain("1");
  });

  it("should handle single line content", () => {
    const content = "single line";
    const preview = createContentPreview(content);

    expect(preview).toContain("single line");
    expect(preview).not.toContain("truncated");
  });
});

describe("read_file character-based truncation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /**
   * Helper to create a mock state with files and set up the mock
   */
  function setupStateWithFiles(files: Record<string, FileData>): {
    state: any;
    runtime: any;
  } {
    const state = { messages: [], files };
    vi.mocked(getCurrentTaskInput).mockReturnValue(state);
    return {
      state,
      runtime: { state, store: undefined },
    };
  }

  /**
   * Helper to create a file with specific content
   */
  function createFileData(
    content: string | Uint8Array,
    mimeType: string = "text/plain",
  ): FileData {
    return {
      content,
      mimeType,
      created_at: new Date().toISOString(),
      modified_at: new Date().toISOString(),
    };
  }

  it("should truncate read_file output when it exceeds character limit", async () => {
    // Create a file with a few very long lines (simulating the problematic case)
    const longLine = "x".repeat(30000); // 30K chars per line
    const fileContent = [longLine, longLine, longLine].join("\n"); // 3 lines, ~90K chars

    const files = { "/large.txt": createFileData(fileContent) };
    const { runtime } = setupStateWithFiles(files);

    // Create middleware with a low token limit to trigger truncation
    const middleware = createFilesystemMiddleware({
      backend: () => new StateBackend(runtime),
      toolTokenLimitBeforeEvict: 1000, // 1000 tokens * 4 chars = 4000 chars limit
    });

    // Get the read_file tool
    const readFileTool = (middleware as any).tools.find(
      (t: StructuredTool) => t.name === "read_file",
    );
    expect(readFileTool).toBeDefined();

    // Invoke the tool
    const result = await readFileTool.invoke(
      { file_path: "/large.txt" },
      { store: undefined },
    );

    // Should return a text content block
    expect(Array.isArray(result)).toBe(true);
    expect(result[0].type).toBe("text");
    // Should be truncated
    expect(result[0].text.length).toBeLessThan(fileContent.length);
    // Should contain truncation message
    expect(result[0].text).toContain("Output was truncated due to size limits");
    expect(result[0].text).toContain("jq");
  });

  it("should not truncate read_file output when under character limit", async () => {
    const shortContent = "line1\nline2\nline3";
    const files = { "/small.txt": createFileData(shortContent) };
    const { runtime } = setupStateWithFiles(files);

    const middleware = createFilesystemMiddleware({
      backend: () => new StateBackend(runtime),
      toolTokenLimitBeforeEvict: 20000, // High limit
    });

    const readFileTool = (middleware as any).tools.find(
      (t: StructuredTool) => t.name === "read_file",
    );

    const result = await readFileTool.invoke(
      { file_path: "/small.txt" },
      { store: undefined },
    );

    // Should return a text content block
    expect(Array.isArray(result)).toBe(true);
    expect(result[0].type).toBe("text");
    // Should NOT contain truncation message
    expect(result[0].text).not.toContain("Output was truncated");
    // Should contain all content
    expect(result[0].text).toContain("line1");
    expect(result[0].text).toContain("line2");
    expect(result[0].text).toContain("line3");
  });

  it("should respect line limit when reading files", async () => {
    // Create file with many lines
    const lines = Array.from({ length: 200 }, (_, i) => `line${i + 1}`);
    const fileContent = lines.join("\n");
    const files = { "/many_lines.txt": createFileData(fileContent) };
    const { runtime } = setupStateWithFiles(files);

    const middleware = createFilesystemMiddleware({
      backend: () => new StateBackend(runtime),
      toolTokenLimitBeforeEvict: 20000,
    });

    const readFileTool = (middleware as any).tools.find(
      (t: any) => t.name === "read_file",
    );

    // Read with a specific line limit
    const result = await readFileTool.invoke(
      { file_path: "/many_lines.txt", limit: 50 },
      { store: undefined },
    );

    // Should return a text content block
    expect(Array.isArray(result)).toBe(true);
    expect(result[0].type).toBe("text");
    // Should contain first 50 lines
    expect(result[0].text).toContain("line1");
    expect(result[0].text).toContain("line50");
    // Should NOT contain lines beyond the limit
    expect(result[0].text).not.toContain("line51");
    expect(result[0].text).not.toContain("line200");
  });

  it("should not truncate when toolTokenLimitBeforeEvict is null", async () => {
    const longLine = "x".repeat(100000);
    const files = { "/huge.txt": createFileData(longLine) };
    const { runtime } = setupStateWithFiles(files);

    const middleware = createFilesystemMiddleware({
      backend: () => new StateBackend(runtime),
      toolTokenLimitBeforeEvict: null, // Disabled
    });

    const readFileTool = (middleware as any).tools.find(
      (t: any) => t.name === "read_file",
    );

    const result = await readFileTool.invoke(
      { file_path: "/huge.txt" },
      { store: undefined },
    );

    // Should return a text content block
    expect(Array.isArray(result)).toBe(true);
    expect(result[0].type).toBe("text");
    // Should NOT contain truncation message (truncation disabled)
    expect(result[0].text).not.toContain("Output was truncated");
    // Should contain the full content (formatted with line numbers)
    expect(result[0].text.length).toBeGreaterThan(100000);
  });
});

describe("read_file multimodal content blocks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function setupStateWithFiles(files: Record<string, FileData>): {
    stateAndStore: any;
  } {
    const state = { messages: [], files };
    vi.mocked(getCurrentTaskInput).mockReturnValue(state);
    return { stateAndStore: { state, store: undefined } };
  }

  function createFileData(
    content: string | Uint8Array,
    mimeType: string = "text/plain",
  ): FileData {
    return {
      content,
      mimeType,
      created_at: new Date().toISOString(),
      modified_at: new Date().toISOString(),
    };
  }

  it("should return an image content block for .png files", async () => {
    const binaryData = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    const files = { "/image.png": createFileData(binaryData, "image/png") };
    const { stateAndStore } = setupStateWithFiles(files);

    const middleware = createFilesystemMiddleware({
      backend: () => new StateBackend(stateAndStore),
    });

    const readFileTool = (middleware as any).tools.find(
      (t: any) => t.name === "read_file",
    );

    const result = await readFileTool.invoke(
      { file_path: "/image.png" },
      { store: undefined },
    );

    expect(Array.isArray(result)).toBe(true);
    expect(result[0].type).toBe("image");
    expect(result[0].mimeType).toBe("image/png");
    expect(result[0].data).toBe(Buffer.from(binaryData).toString("base64"));
  });

  it("should return an image content block for .jpg files", async () => {
    const binaryData = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
    const files = { "/photo.jpg": createFileData(binaryData, "image/jpeg") };
    const { stateAndStore } = setupStateWithFiles(files);

    const middleware = createFilesystemMiddleware({
      backend: () => new StateBackend(stateAndStore),
    });

    const readFileTool = (middleware as any).tools.find(
      (t: any) => t.name === "read_file",
    );

    const result = await readFileTool.invoke(
      { file_path: "/photo.jpg" },
      { store: undefined },
    );

    expect(result[0].type).toBe("image");
    expect(result[0].mimeType).toBe("image/jpeg");
  });

  it("should return an audio content block for .mp3 files", async () => {
    const binaryData = new Uint8Array([0x49, 0x44, 0x33, 0x04]);
    const files = { "/audio.mp3": createFileData(binaryData, "audio/mpeg") };
    const { stateAndStore } = setupStateWithFiles(files);

    const middleware = createFilesystemMiddleware({
      backend: () => new StateBackend(stateAndStore),
    });

    const readFileTool = (middleware as any).tools.find(
      (t: any) => t.name === "read_file",
    );

    const result = await readFileTool.invoke(
      { file_path: "/audio.mp3" },
      { store: undefined },
    );

    expect(Array.isArray(result)).toBe(true);
    expect(result[0].type).toBe("audio");
    expect(result[0].mimeType).toBe("audio/mpeg");
    expect(result[0].data).toBe(Buffer.from(binaryData).toString("base64"));
  });

  it("should return a video content block for .mp4 files", async () => {
    const binaryData = new Uint8Array([
      0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70,
    ]);
    const files = { "/video.mp4": createFileData(binaryData, "video/mp4") };
    const { stateAndStore } = setupStateWithFiles(files);

    const middleware = createFilesystemMiddleware({
      backend: () => new StateBackend(stateAndStore),
    });

    const readFileTool = (middleware as any).tools.find(
      (t: any) => t.name === "read_file",
    );

    const result = await readFileTool.invoke(
      { file_path: "/video.mp4" },
      { store: undefined },
    );

    expect(Array.isArray(result)).toBe(true);
    expect(result[0].type).toBe("video");
    expect(result[0].mimeType).toBe("video/mp4");
    expect(result[0].data).toBe(Buffer.from(binaryData).toString("base64"));
  });

  it("should return a file content block for .pdf files", async () => {
    const binaryData = new Uint8Array([
      0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34,
    ]);
    const files = {
      "/document.pdf": createFileData(binaryData, "application/pdf"),
    };
    const { stateAndStore } = setupStateWithFiles(files);

    const middleware = createFilesystemMiddleware({
      backend: () => new StateBackend(stateAndStore),
    });

    const readFileTool = (middleware as any).tools.find(
      (t: any) => t.name === "read_file",
    );

    const result = await readFileTool.invoke(
      { file_path: "/document.pdf" },
      { store: undefined },
    );

    expect(Array.isArray(result)).toBe(true);
    expect(result[0].type).toBe("file");
    expect(result[0].mimeType).toBe("application/pdf");
    expect(result[0].data).toBe(Buffer.from(binaryData).toString("base64"));
  });

  it("should return a text content block with line numbers for text files", async () => {
    const files = { "/notes.txt": createFileData("hello\nworld") };
    const { stateAndStore } = setupStateWithFiles(files);

    const middleware = createFilesystemMiddleware({
      backend: () => new StateBackend(stateAndStore),
    });

    const readFileTool = (middleware as any).tools.find(
      (t: any) => t.name === "read_file",
    );

    const result = await readFileTool.invoke(
      { file_path: "/notes.txt" },
      { store: undefined },
    );

    expect(Array.isArray(result)).toBe(true);
    expect(result[0].type).toBe("text");
    expect(result[0].text).toContain("hello");
    expect(result[0].text).toContain("world");
    // Line numbers should be present
    expect(result[0].text).toMatch(/1\s+hello/);
    expect(result[0].text).toMatch(/2\s+world/);
  });

  it("should return an error for binary files exceeding MAX_BINARY_READ_SIZE_BYTES", async () => {
    const oversizeData = new Uint8Array(MAX_BINARY_READ_SIZE_BYTES + 1);
    const files = { "/large.png": createFileData(oversizeData, "image/png") };
    const { stateAndStore } = setupStateWithFiles(files);

    const middleware = createFilesystemMiddleware({
      backend: () => new StateBackend(stateAndStore),
    });

    const readFileTool = (middleware as any).tools.find(
      (t: any) => t.name === "read_file",
    );

    const result = await readFileTool.invoke(
      { file_path: "/large.png" },
      { store: undefined },
    );

    expect(Array.isArray(result)).toBe(true);
    expect(result[0].type).toBe("text");
    expect(result[0].text).toContain("Error");
    expect(result[0].text).toContain("too large");
    expect(result[0].text).toContain(
      `${MAX_BINARY_READ_SIZE_BYTES / (1024 * 1024)}MB`,
    );
  });

  it("should return an image block for binary files under MAX_BINARY_READ_SIZE_BYTES", async () => {
    const undersizeData = new Uint8Array(MAX_BINARY_READ_SIZE_BYTES - 1);
    const files = { "/ok.png": createFileData(undersizeData, "image/png") };
    const { stateAndStore } = setupStateWithFiles(files);

    const middleware = createFilesystemMiddleware({
      backend: () => new StateBackend(stateAndStore),
    });

    const readFileTool = (middleware as any).tools.find(
      (t: any) => t.name === "read_file",
    );

    const result = await readFileTool.invoke(
      { file_path: "/ok.png" },
      { store: undefined },
    );

    expect(result[0].type).toBe("image");
    expect(typeof result[0].data).toBe("string");
  });

  it("should return an error text content block for missing files", async () => {
    const { stateAndStore } = setupStateWithFiles({});

    const middleware = createFilesystemMiddleware({
      backend: () => new StateBackend(stateAndStore),
    });

    const readFileTool = (middleware as any).tools.find(
      (t: any) => t.name === "read_file",
    );

    const result = await readFileTool.invoke(
      { file_path: "/nonexistent.txt" },
      { store: undefined },
    );

    expect(Array.isArray(result)).toBe(true);
    expect(result[0].type).toBe("text");
    expect(result[0].text).toContain("not found");
  });
});
