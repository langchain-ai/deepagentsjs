import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ToolMessage } from "langchain";
import { Command } from "@langchain/langgraph";

import { createFilesystemMiddleware } from "./fs.js";
import { FilesystemBackend } from "../backends/filesystem.js";
import { StateBackend } from "../backends/state.js";
import type { BackendProtocolV2 } from "../backends/protocol.js";

function getEditTool(
  middleware: ReturnType<typeof createFilesystemMiddleware>,
) {
  const editTool = middleware.tools!.find((tool) => tool.name === "edit_file");
  expect(editTool).toBeDefined();
  return editTool!;
}

async function invokeEdit(
  middleware: ReturnType<typeof createFilesystemMiddleware>,
  args: Record<string, unknown>,
): Promise<ToolMessage | Command> {
  return (await getEditTool(middleware).invoke({
    type: "tool_call",
    id: "call-edit",
    name: "edit_file",
    args,
  })) as ToolMessage | Command;
}

function expectToolMessage(result: unknown): ToolMessage {
  expect(ToolMessage.isInstance(result)).toBe(true);
  return result as ToolMessage;
}

describe("edit_file with multiple edits", () => {
  let root: string;
  let filePath: string;
  let middleware: ReturnType<typeof createFilesystemMiddleware>;

  const original = [
    "function greet(name) {",
    '  return "Hello, " + name;',
    "}",
    "",
    "function farewell(name) {",
    '  return "Bye, " + name;',
    "}",
    "",
  ].join("\n");

  beforeEach(async () => {
    root = fsSync.mkdtempSync(path.join(os.tmpdir(), "deepagents-multi-edit-"));
    filePath = path.join(root, "greet.js");
    await fs.writeFile(filePath, original, "utf-8");
    middleware = createFilesystemMiddleware({
      backend: new FilesystemBackend({ rootDir: root, virtualMode: true }),
    });
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("applies every edit in one call", async () => {
    const result = expectToolMessage(
      await invokeEdit(middleware, {
        file_path: "/greet.js",
        old_string: '"Hello, "',
        new_string: '"Hi, "',
        edits: [
          { old_string: '"Bye, "', new_string: '"See you, "' },
          { old_string: "farewell", new_string: "goodbye" },
        ],
      }),
    );

    expect(result.status).not.toBe("error");
    expect(result.content).toBe(
      "Successfully replaced 3 occurrence(s) in '/greet.js'",
    );
    expect(await fs.readFile(filePath, "utf-8")).toBe(
      original
        .replace('"Hello, "', '"Hi, "')
        .replace('"Bye, "', '"See you, "')
        .replace("farewell", "goodbye"),
    );
  });

  it("matches each edit against the original content", async () => {
    const result = expectToolMessage(
      await invokeEdit(middleware, {
        file_path: "/greet.js",
        old_string: "greet",
        new_string: "farewell",
        edits: [{ old_string: "farewell", new_string: "goodbye" }],
      }),
    );

    expect(result.status).not.toBe("error");
    const updated = await fs.readFile(filePath, "utf-8");
    expect(updated).toContain('function farewell(name) {\n  return "Hello');
    expect(updated).toContain('function goodbye(name) {\n  return "Bye');
  });

  it("supports replace_all on individual edits", async () => {
    const result = expectToolMessage(
      await invokeEdit(middleware, {
        file_path: "/greet.js",
        old_string: "function greet",
        new_string: "export function greet",
        edits: [{ old_string: "name", new_string: "who", replace_all: true }],
      }),
    );

    expect(result.content).toBe(
      "Successfully replaced 5 occurrence(s) in '/greet.js'",
    );
    const updated = await fs.readFile(filePath, "utf-8");
    expect(updated).not.toContain("name");
    expect(updated).toContain("export function greet(who) {");
  });

  it.each([
    {
      case: "overlapping edits",
      edit: { old_string: 'Hello, " + name', new_string: "x" },
      error:
        "Error: Edits overlap: 'return \"Hello' and 'Hello, \" + name' match overlapping text in file. Combine them into a single edit.",
    },
    {
      case: "an edit that is not found",
      edit: { old_string: "missing", new_string: "x" },
      error: "Error: String not found in file: 'missing'",
    },
    {
      case: "an ambiguous edit",
      edit: { old_string: "name", new_string: "x" },
      error:
        "Error: String 'name' has multiple occurrences (appears 4 times) in file. Use replace_all=True to replace all instances, or provide a more specific string with surrounding context.",
    },
  ])("rejects $case without changing the file", async ({ edit, error }) => {
    const result = expectToolMessage(
      await invokeEdit(middleware, {
        file_path: "/greet.js",
        old_string: 'return "Hello',
        new_string: 'return "Hi',
        edits: [{ old_string: "farewell", new_string: "goodbye" }, edit],
      }),
    );

    expect(result.status).toBe("error");
    expect(result.content).toBe(error);
    expect(await fs.readFile(filePath, "utf-8")).toBe(original);
  });

  it("reports a missing file", async () => {
    const result = expectToolMessage(
      await invokeEdit(middleware, {
        file_path: "/missing.js",
        old_string: "a",
        new_string: "b",
        edits: [{ old_string: "c", new_string: "d" }],
      }),
    );

    expect(result.status).toBe("error");
    expect(result.content).toContain("not found");
  });

  it("keeps the single-edit form unchanged when edits is empty", async () => {
    const result = expectToolMessage(
      await invokeEdit(middleware, {
        file_path: "/greet.js",
        old_string: "farewell",
        new_string: "goodbye",
        edits: [],
      }),
    );

    expect(result.content).toBe(
      "Successfully replaced 1 occurrence(s) in '/greet.js'",
    );
    expect(await fs.readFile(filePath, "utf-8")).toBe(
      original.replace("farewell", "goodbye"),
    );
  });
});

describe("edit_file with multiple edits on other backends", () => {
  it("returns a state update from StateBackend", async () => {
    const backend = new StateBackend({
      state: {
        files: {
          "/notes.md": {
            content: ["# Title", "", "first", "second"],
            created_at: "2024-01-01T00:00:00Z",
            modified_at: "2024-01-01T00:00:00Z",
          },
        },
      },
    } as any);
    const middleware = createFilesystemMiddleware({ backend });

    const result = await invokeEdit(middleware, {
      file_path: "/notes.md",
      old_string: "first",
      new_string: "1st",
      edits: [{ old_string: "second", new_string: "2nd" }],
    });

    expect(result).toBeInstanceOf(Command);
    const update = (result as Command).update as {
      files: Record<string, { content: string | string[] }>;
      messages: ToolMessage[];
    };
    const content = update.files["/notes.md"].content;
    expect(Array.isArray(content) ? content.join("\n") : content).toBe(
      "# Title\n\n1st\n2nd",
    );
    expect(update.messages[0].content).toBe(
      "Successfully replaced 2 occurrence(s) in '/notes.md'",
    );
  });

  it("writes through a single backend edit of the original content", async () => {
    const backend = {
      readRaw: vi.fn().mockResolvedValue({
        data: {
          content: "a b c",
          mimeType: "text/plain",
          created_at: "2024-01-01T00:00:00Z",
          modified_at: "2024-01-01T00:00:00Z",
        },
      }),
      edit: vi.fn().mockResolvedValue({
        path: "/f.txt",
        filesUpdate: null,
        occurrences: 1,
      }),
    } as unknown as BackendProtocolV2;
    const middleware = createFilesystemMiddleware({ backend });

    const result = expectToolMessage(
      await invokeEdit(middleware, {
        file_path: "/f.txt",
        old_string: "a",
        new_string: "A",
        edits: [{ old_string: "c", new_string: "C" }],
      }),
    );

    expect(backend.edit).toHaveBeenCalledTimes(1);
    expect(backend.edit).toHaveBeenCalledWith(
      "/f.txt",
      "a b c",
      "A b C",
      false,
    );
    expect(result.content).toBe(
      "Successfully replaced 2 occurrence(s) in '/f.txt'",
    );
  });

  it("reports a concurrent change instead of echoing the whole file", async () => {
    const backend = {
      readRaw: vi.fn().mockResolvedValue({
        data: {
          content: "a b c",
          mimeType: "text/plain",
          created_at: "2024-01-01T00:00:00Z",
          modified_at: "2024-01-01T00:00:00Z",
        },
      }),
      edit: vi.fn().mockResolvedValue({
        error: "Error: String not found in file: 'a b c'",
      }),
    } as unknown as BackendProtocolV2;
    const middleware = createFilesystemMiddleware({ backend });

    const result = expectToolMessage(
      await invokeEdit(middleware, {
        file_path: "/f.txt",
        old_string: "a",
        new_string: "A",
        edits: [{ old_string: "c", new_string: "C" }],
      }),
    );

    expect(result.status).toBe("error");
    expect(result.content).toBe(
      "Error: Failed to apply edits to '/f.txt': the file changed after it was read",
    );
  });

  it("rejects binary files without writing", async () => {
    const backend = {
      readRaw: vi.fn().mockResolvedValue({
        data: {
          content: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
          mimeType: "image/png",
          created_at: "2024-01-01T00:00:00Z",
          modified_at: "2024-01-01T00:00:00Z",
        },
      }),
      edit: vi.fn(),
    } as unknown as BackendProtocolV2;
    const middleware = createFilesystemMiddleware({ backend });

    const result = expectToolMessage(
      await invokeEdit(middleware, {
        file_path: "/image.png",
        old_string: "a",
        new_string: "b",
        edits: [{ old_string: "c", new_string: "d" }],
      }),
    );

    expect(result.status).toBe("error");
    expect(result.content).toBe("Error: Cannot edit binary file '/image.png'");
    expect(backend.edit).not.toHaveBeenCalled();
  });
});
