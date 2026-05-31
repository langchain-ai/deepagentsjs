import { describe, it, expect } from "vitest";
import {
  validatePath,
  validateFilePath,
  sanitizeToolCallId,
  formatContentWithLineNumbers,
  updateFileData,
  fileDataToString,
  checkEmptyContent,
  performStringReplacement,
  truncateIfTooLong,
  isFileDataV1,
  migrateToFileDataV2,
  getMimeType,
  isTextMimeType,
  adaptBackendProtocol,
  TOOL_RESULT_TOKEN_LIMIT,
  createFileData,
  adaptSandboxProtocol,
} from "./utils.js";
import type {
  BackendProtocol,
  BackendProtocolV2,
  GrepMatch,
  SandboxBackendProtocol,
  SandboxBackendProtocolV2,
} from "./protocol.js";
import { isSandboxBackend } from "./protocol.js";

describe("validatePath", () => {
  it("should add leading slash if missing", () => {
    expect(validatePath("foo/bar")).toBe("/foo/bar/");
  });

  it("should add trailing slash if missing", () => {
    expect(validatePath("/foo/bar")).toBe("/foo/bar/");
  });

  it("should handle root path", () => {
    expect(validatePath("/")).toBe("/");
  });

  it("should handle null path", () => {
    expect(validatePath(null)).toBe("/");
  });

  it("should handle undefined path", () => {
    expect(validatePath(undefined)).toBe("/");
  });

  it("should handle empty string", () => {
    expect(validatePath("")).toBe("/");
  });
});

describe("validateFilePath", () => {
  it("should normalize paths without leading slash", () => {
    expect(validateFilePath("foo/bar")).toBe("/foo/bar");
  });

  it("should normalize paths with redundant slashes", () => {
    expect(validateFilePath("/foo//bar")).toBe("/foo/bar");
  });

  it("should remove dot components", () => {
    expect(validateFilePath("/./foo/./bar")).toBe("/foo/bar");
  });

  it("should reject path traversal with ..", () => {
    expect(() => validateFilePath("../etc/passwd")).toThrow(
      "Path traversal not allowed",
    );
  });

  it("should reject path traversal with .. in middle", () => {
    expect(() => validateFilePath("/foo/../bar")).toThrow(
      "Path traversal not allowed",
    );
  });

  it("should reject tilde paths", () => {
    expect(() => validateFilePath("~/secret")).toThrow(
      "Path traversal not allowed",
    );
  });

  it("should reject Windows absolute paths with backslash", () => {
    expect(() => validateFilePath("C:\\Users\\file.txt")).toThrow(
      "Windows absolute paths are not supported",
    );
  });

  it("should reject Windows absolute paths with forward slash", () => {
    expect(() => validateFilePath("C:/Users/file.txt")).toThrow(
      "Windows absolute paths are not supported",
    );
  });

  it("should reject lowercase Windows paths", () => {
    expect(() => validateFilePath("c:/users/file.txt")).toThrow(
      "Windows absolute paths are not supported",
    );
  });

  it("should normalize backslashes to forward slashes", () => {
    expect(validateFilePath("/foo\\bar")).toBe("/foo/bar");
  });

  it("should validate allowed prefixes when provided", () => {
    expect(validateFilePath("/data/file.txt", ["/data/"])).toBe(
      "/data/file.txt",
    );
  });

  it("should reject paths not starting with allowed prefixes", () => {
    expect(() => validateFilePath("/etc/passwd", ["/data/"])).toThrow(
      'Path must start with one of ["/data/"]',
    );
  });

  it("should accept any of multiple allowed prefixes", () => {
    expect(validateFilePath("/data/file.txt", ["/tmp/", "/data/"])).toBe(
      "/data/file.txt",
    );
    expect(validateFilePath("/tmp/file.txt", ["/tmp/", "/data/"])).toBe(
      "/tmp/file.txt",
    );
  });

  it("should handle root path", () => {
    expect(validateFilePath("/")).toBe("/");
  });
});

describe("sanitizeToolCallId", () => {
  it("should replace dots with underscores", () => {
    expect(sanitizeToolCallId("call.123")).toBe("call_123");
  });

  it("should replace forward slashes with underscores", () => {
    expect(sanitizeToolCallId("call/123")).toBe("call_123");
  });

  it("should replace backslashes with underscores", () => {
    expect(sanitizeToolCallId("call\\123")).toBe("call_123");
  });

  it("should handle multiple replacements", () => {
    expect(sanitizeToolCallId("call.foo/bar\\baz")).toBe("call_foo_bar_baz");
  });

  it("should leave safe strings unchanged", () => {
    expect(sanitizeToolCallId("call_123_abc")).toBe("call_123_abc");
  });
});

describe("formatContentWithLineNumbers", () => {
  it("should format string content with line numbers", () => {
    const result = formatContentWithLineNumbers("line1\nline2");
    expect(result).toContain("1");
    expect(result).toContain("line1");
    expect(result).toContain("2");
    expect(result).toContain("line2");
  });

  it("should format array content with line numbers", () => {
    const result = formatContentWithLineNumbers(["line1", "line2"]);
    expect(result).toContain("1");
    expect(result).toContain("line1");
    expect(result).toContain("2");
    expect(result).toContain("line2");
  });

  it("should use custom start line", () => {
    const result = formatContentWithLineNumbers("line1", 10);
    expect(result).toContain("10");
    expect(result).toContain("line1");
  });

  it("should handle empty trailing newline", () => {
    const result = formatContentWithLineNumbers("line1\nline2\n");
    const lines = result.split("\n");
    expect(lines.length).toBe(2);
  });
});

describe("createFileData", () => {
  it("should default to v2 format (content as single string)", () => {
    const result = createFileData("line1\nline2");
    expect(result.content).toBe("line1\nline2");
  });

  it("should create v1 format when fileFormat is v1", () => {
    const result = createFileData("line1\nline2", undefined, "v1");
    expect(result.content).toEqual(["line1", "line2"]);
  });

  it("should set created_at and modified_at timestamps", () => {
    const result = createFileData("content");
    expect(result.created_at).toBeDefined();
    expect(result.modified_at).toBeDefined();
    expect(new Date(result.created_at).getTime()).toBeGreaterThan(0);
  });

  it("should use provided createdAt timestamp", () => {
    const timestamp = "2023-01-01T00:00:00.000Z";
    const result = createFileData("content", timestamp);
    expect(result.created_at).toBe(timestamp);
  });

  it("should store Uint8Array content directly in v2 format", () => {
    const binary = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const result = createFileData(binary);
    expect(result.content).toBeInstanceOf(Uint8Array);
    expect(result.content).toEqual(binary);
  });

  it("should throw when passing binary data with v1 format", () => {
    const binary = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    expect(() => createFileData(binary, undefined, "v1")).toThrow();
  });
});

describe("updateFileData", () => {
  it("should update v1 content while preserving created_at", () => {
    const original = createFileData("old content", undefined, "v1");
    const originalCreatedAt = original.created_at;

    const updated = updateFileData(original, "new content");
    expect(updated.content).toEqual(["new content"]);
    expect(updated.created_at).toBe(originalCreatedAt);
  });

  it("should update v2 content while preserving created_at", () => {
    const original = createFileData("old content");
    const originalCreatedAt = original.created_at;

    const updated = updateFileData(original, "new content");
    expect(updated.content).toBe("new content");
    expect(updated.created_at).toBe(originalCreatedAt);
  });

  it("should update modified_at timestamp", () => {
    const original = createFileData("old content", undefined, "v1");
    const updated = updateFileData(original, "new content");
    expect(updated.modified_at).toBeDefined();
  });
});

describe("fileDataToString", () => {
  it("should join v1 lines with newlines", () => {
    const fileData = createFileData("line1\nline2\nline3", undefined, "v1");
    const result = fileDataToString(fileData);
    expect(result).toBe("line1\nline2\nline3");
  });

  it("should return v2 content as-is", () => {
    const fileData = createFileData("line1\nline2\nline3");
    const result = fileDataToString(fileData);
    expect(result).toBe("line1\nline2\nline3");
  });
});

describe("checkEmptyContent", () => {
  it("should return warning for empty string", () => {
    expect(checkEmptyContent("")).not.toBeNull();
  });

  it("should return warning for whitespace-only string", () => {
    expect(checkEmptyContent("   \n\t  ")).not.toBeNull();
  });

  it("should return null for non-empty content", () => {
    expect(checkEmptyContent("hello")).toBeNull();
  });
});

describe("performStringReplacement", () => {
  it("should replace string and return new content with occurrence count", () => {
    const result = performStringReplacement(
      "hello world",
      "world",
      "there",
      false,
    );
    expect(result).toEqual(["hello there", 1]);
  });

  it("should return error if string not found", () => {
    const result = performStringReplacement("hello world", "foo", "bar", false);
    expect(typeof result).toBe("string");
    expect(result).toContain("not found");
  });

  it("should return error if multiple occurrences and replaceAll is false", () => {
    const result = performStringReplacement("foo foo foo", "foo", "bar", false);
    expect(typeof result).toBe("string");
    expect(result).toContain("appears 3 times");
  });

  it("should replace all occurrences when replaceAll is true", () => {
    const result = performStringReplacement("foo foo foo", "foo", "bar", true);
    expect(result).toEqual(["bar bar bar", 3]);
  });

  it("should return error if oldString is empty with non-empty content", () => {
    const result = performStringReplacement("hello world", "", "bar", false);
    expect(typeof result).toBe("string");
    expect(result).toContain("oldString cannot be empty");
  });

  it("should set initial content when both content and oldString are empty", () => {
    const result = performStringReplacement("", "", "initial content", false);
    expect(result).toEqual(["initial content", 0]);
  });

  it("should set initial content when both content and oldString are empty with replaceAll", () => {
    const result = performStringReplacement("", "", "initial content", true);
    expect(result).toEqual(["initial content", 0]);
  });

  it("should return error if oldString is empty with replaceAll true and non-empty content", () => {
    const result = performStringReplacement("hello", "", "bar", true);
    expect(typeof result).toBe("string");
    expect(result).toContain("oldString cannot be empty");
  });

  it("should allow setting empty content on empty file", () => {
    const result = performStringReplacement("", "", "", false);
    expect(result).toEqual(["", 0]);
  });
});

describe("truncateIfTooLong", () => {
  it("should return array unchanged if under limit", () => {
    const input = ["short", "lines"];
    expect(truncateIfTooLong(input)).toEqual(input);
  });

  it("should return string unchanged if under limit", () => {
    const input = "short string";
    expect(truncateIfTooLong(input)).toBe(input);
  });

  it("should truncate long strings", () => {
    const input = "x".repeat(TOOL_RESULT_TOKEN_LIMIT * 5);
    const result = truncateIfTooLong(input);
    expect(result.length).toBeLessThan(input.length);
    expect(result).toContain("truncated");
  });

  it("should truncate long arrays", () => {
    const input = Array(1000).fill("a".repeat(100));
    const result = truncateIfTooLong(input) as string[];
    expect(result.length).toBeLessThan(input.length);
    expect(result[result.length - 1]).toContain("truncated");
  });
});

describe("isFileDataV1", () => {
  it("should return true for v1 data", () => {
    const v1 = createFileData("hello", undefined, "v1");
    expect(isFileDataV1(v1)).toBe(true);
  });

  it("should return false for v2 data", () => {
    const v2 = createFileData("hello");
    expect(isFileDataV1(v2)).toBe(false);
  });
});

describe("migrateToFileDataV2", () => {
  it("should convert v1 data by joining lines", () => {
    const v1 = createFileData("line1\nline2", undefined, "v1");
    const v2 = migrateToFileDataV2(v1, "/test.txt");
    expect(v2.content).toBe("line1\nline2");
    expect(v2.mimeType).toBe("text/plain");
    expect(v2.created_at).toBe(v1.created_at);
    expect(v2.modified_at).toBe(v1.modified_at);
  });

  it("should return v2 data unchanged", () => {
    const v2 = createFileData("hello");
    expect(migrateToFileDataV2(v2, "/test.txt")).toBe(v2);
  });
});

describe("getMimeType", () => {
  it("should return correct MIME type for known extensions", () => {
    expect(getMimeType("/image.png")).toBe("image/png");
    expect(getMimeType("/photo.jpg")).toBe("image/jpeg");
    expect(getMimeType("/doc.pdf")).toBe("application/pdf");
  });

  it("should return correct MIME types for image extensions", () => {
    expect(getMimeType("/a.png")).toBe("image/png");
    expect(getMimeType("/a.jpg")).toBe("image/jpeg");
    expect(getMimeType("/a.jpeg")).toBe("image/jpeg");
    expect(getMimeType("/a.gif")).toBe("image/gif");
    expect(getMimeType("/a.webp")).toBe("image/webp");
    expect(getMimeType("/a.svg")).toBe("image/svg+xml");
    expect(getMimeType("/a.heic")).toBe("image/heic");
    expect(getMimeType("/a.heif")).toBe("image/heif");
  });

  it("should return correct MIME types for audio extensions", () => {
    expect(getMimeType("/a.mp3")).toBe("audio/mpeg");
    expect(getMimeType("/a.wav")).toBe("audio/wav");
    expect(getMimeType("/a.aiff")).toBe("audio/aiff");
    expect(getMimeType("/a.aac")).toBe("audio/aac");
    expect(getMimeType("/a.ogg")).toBe("audio/ogg");
    expect(getMimeType("/a.flac")).toBe("audio/flac");
  });

  it("should return correct MIME types for video extensions", () => {
    expect(getMimeType("/a.mp4")).toBe("video/mp4");
    expect(getMimeType("/a.webm")).toBe("video/webm");
    expect(getMimeType("/a.mpeg")).toBe("video/mpeg");
    expect(getMimeType("/a.mov")).toBe("video/quicktime");
    expect(getMimeType("/a.avi")).toBe("video/x-msvideo");
    expect(getMimeType("/a.flv")).toBe("video/x-flv");
    expect(getMimeType("/a.mpg")).toBe("video/mpeg");
    expect(getMimeType("/a.wmv")).toBe("video/x-ms-wmv");
    expect(getMimeType("/a.3gpp")).toBe("video/3gpp");
  });

  it("should return correct MIME types for document extensions", () => {
    expect(getMimeType("/a.pdf")).toBe("application/pdf");
    expect(getMimeType("/a.ppt")).toBe("application/vnd.ms-powerpoint");
    expect(getMimeType("/a.pptx")).toBe(
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    );
  });

  it("should be case-insensitive", () => {
    expect(getMimeType("/image.PNG")).toBe("image/png");
    expect(getMimeType("/video.MOV")).toBe("video/quicktime");
    expect(getMimeType("/audio.FLAC")).toBe("audio/flac");
  });

  it("should return text/plain for unknown extensions", () => {
    expect(getMimeType("/file.txt")).toBe("text/plain");
    expect(getMimeType("/code.ts")).toBe("text/plain");
    expect(getMimeType("/unknown.xyz")).toBe("text/plain");
  });
});

describe("isTextMimeType", () => {
  it("should return true for text types", () => {
    expect(isTextMimeType("text/plain")).toBe(true);
    expect(isTextMimeType("text/html")).toBe(true);
    expect(isTextMimeType("application/json")).toBe(true);
    expect(isTextMimeType("application/javascript")).toBe(true);
  });

  it("should return true for image/svg+xml", () => {
    expect(isTextMimeType("image/svg+xml")).toBe(true);
  });

  it("should return false for binary types", () => {
    expect(isTextMimeType("image/png")).toBe(false);
    expect(isTextMimeType("application/pdf")).toBe(false);
    expect(isTextMimeType("audio/mpeg")).toBe(false);
    expect(isTextMimeType("video/mp4")).toBe(false);
    expect(isTextMimeType("image/heic")).toBe(false);
    expect(isTextMimeType("audio/flac")).toBe(false);
    expect(isTextMimeType("video/quicktime")).toBe(false);
    expect(isTextMimeType("application/vnd.ms-powerpoint")).toBe(false);
  });
});

describe("adaptBackendProtocol", () => {
  function createV1Backend(): BackendProtocol {
    return {
      lsInfo: () => [],
      read: (filePath: string) => `content of ${filePath}`,
      readRaw: (_filePath: string) => ({
        content: ["line1", "line2"],
        created_at: "2024-01-01T00:00:00.000Z",
        modified_at: "2024-01-01T00:00:00.000Z",
      }),
      grepRaw: (_pattern: string) =>
        [{ path: "/file.txt", line: 1, text: "match" }] as GrepMatch[],
      globInfo: () => [],
      write: () => ({ path: "/file.txt", filesUpdate: null }),
      edit: () => ({ path: "/file.txt", filesUpdate: null, occurrences: 1 }),
    };
  }

  function createV2Backend(): BackendProtocolV2 {
    return {
      ls: () => ({ files: [] }),
      read: () => ({ content: "v2 content" }),
      readRaw: () => ({
        data: {
          content: "v2 raw",
          mimeType: "text/plain",
          created_at: "2024-01-01T00:00:00.000Z",
          modified_at: "2024-01-01T00:00:00.000Z",
        },
      }),
      grep: () => ({
        matches: [{ path: "/file.txt", line: 1, text: "match" }],
      }),
      glob: () => ({ files: [] }),
      write: () => ({ path: "/file.txt", filesUpdate: null }),
      edit: () => ({ path: "/file.txt", filesUpdate: null, occurrences: 1 }),
    };
  }

  describe("adapting a v1 backend", () => {
    it("should wrap read() string return in ReadResult", async () => {
      const adapted = adaptBackendProtocol(createV1Backend());
      const result = await adapted.read("/test.txt");
      expect(result).toEqual({ content: "content of /test.txt" });
    });

    it("should wrap grep() GrepMatch[] return in GrepResult", async () => {
      const adapted = adaptBackendProtocol(createV1Backend());
      const result = await adapted.grep("match");
      expect(result.matches).toHaveLength(1);
      expect(result.matches![0].path).toBe("/file.txt");
    });

    it("should wrap grep() error string return in GrepResult", async () => {
      const v1 = createV1Backend();
      v1.grepRaw = () => "Invalid pattern";
      const adapted = adaptBackendProtocol(v1);
      const result = await adapted.grep("bad");
      expect(result.error).toBe("Invalid pattern");
      expect(result.matches).toBeUndefined();
    });

    it("should migrate readRaw() v1 content to v2", async () => {
      const adapted = adaptBackendProtocol(createV1Backend());
      const result = await adapted.readRaw("/test.txt");
      expect(result.error).toBeUndefined();
      expect(typeof result.data!.content).toBe("string");
      expect(result.data!.content).toBe("line1\nline2");
    });

    it("should pass through ls, glob, write, edit", async () => {
      const adapted = adaptBackendProtocol(createV1Backend());
      const lsResult = await adapted.ls("/");
      expect(lsResult.error).toBeUndefined();
      expect(lsResult.files).toEqual([]);

      const globResult = await adapted.glob("*");
      expect(globResult.error).toBeUndefined();
      expect(globResult.files).toEqual([]);

      const writeRes = await adapted.write("/f.txt", "content");
      expect(writeRes.path).toBe("/file.txt");

      const editRes = await adapted.edit("/f.txt", "old", "new");
      expect(editRes.occurrences).toBe(1);
    });
  });

  describe("adapting a v2 backend", () => {
    it("should pass through read() ReadResult unchanged", async () => {
      const adapted = adaptBackendProtocol(createV2Backend());
      const result = await adapted.read("/test.txt");
      expect(result).toEqual({ content: "v2 content" });
    });

    it("should pass through grep() GrepResult unchanged", async () => {
      const adapted = adaptBackendProtocol(createV2Backend());
      const result = await adapted.grep("match");
      expect(result.matches).toHaveLength(1);
    });

    it("should pass through readRaw() v2 content unchanged", async () => {
      const adapted = adaptBackendProtocol(createV2Backend());
      const result = await adapted.readRaw("/test.txt");
      expect(result.error).toBeUndefined();
      expect(result.data!.content).toBe("v2 raw");
    });
  });

  describe("sandbox properties", () => {
    it("should preserve execute and id for sandbox backends", async () => {
      const v1 = createV1Backend() as unknown as SandboxBackendProtocol;
      (v1 as any).execute = (cmd: string) => ({
        output: `ran: ${cmd}`,
        exitCode: 0,
        truncated: false,
      });
      Object.defineProperty(v1, "id", { value: "sandbox-1", enumerable: true });

      const adapted = adaptSandboxProtocol(v1 as any);
      expect(isSandboxBackend(adapted)).toBe(true);

      const sb = adapted as unknown as SandboxBackendProtocol;
      expect(sb.id).toBe("sandbox-1");
      const execResult = await sb.execute("echo hi");
      expect(execResult.output).toBe("ran: echo hi");
    });

    it("should preserve execute and id for V2 sandbox backends", async () => {
      const v2 = createV2Backend() as unknown as SandboxBackendProtocolV2;
      (v2 as any).execute = (cmd: string) => ({
        output: `ran: ${cmd}`,
        exitCode: 0,
        truncated: false,
      });
      Object.defineProperty(v2, "id", { value: "sandbox-2", enumerable: true });

      const adapted = adaptSandboxProtocol(v2 as any);
      expect(isSandboxBackend(adapted)).toBe(true);

      const sb = adapted as unknown as SandboxBackendProtocolV2;
      expect(sb.id).toBe("sandbox-2");
      const execResult = await sb.execute("echo hi");
      expect(execResult.output).toBe("ran: echo hi");
    });

    it("should not add sandbox properties to non-sandbox backends", () => {
      const adapted = adaptBackendProtocol(createV1Backend());
      expect(isSandboxBackend(adapted)).toBe(false);
    });
  });

  describe("optional methods", () => {
    it("should preserve uploadFiles when present", () => {
      const v1 = createV1Backend();
      v1.uploadFiles = () => [{ path: "/f.txt", error: null }];
      const adapted = adaptBackendProtocol(v1);
      expect(adapted.uploadFiles).toBeDefined();
    });

    it("should preserve downloadFiles when present", () => {
      const v1 = createV1Backend();
      v1.downloadFiles = () => [
        { path: "/f.txt", content: new Uint8Array(), error: null },
      ];
      const adapted = adaptBackendProtocol(v1);
      expect(adapted.downloadFiles).toBeDefined();
    });

    it("should leave uploadFiles undefined when absent", () => {
      const adapted = adaptBackendProtocol(createV1Backend());
      expect(adapted.uploadFiles).toBeUndefined();
    });

    it("should leave downloadFiles undefined when absent", () => {
      const adapted = adaptBackendProtocol(createV1Backend());
      expect(adapted.downloadFiles).toBeUndefined();
    });
  });
});
