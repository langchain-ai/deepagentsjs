import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  generateId,
  serializeJsonl,
  parseJsonl,
  pathsToRows,
  globFiles,
  createTable,
  loadTable,
  saveTable,
  _resetForTesting,
} from "../source/table.js";

// ---------------------------------------------------------------------------
// In-memory file system stub for PTC glob tool
// ---------------------------------------------------------------------------

let files: Map<string, string>;

function setupTools(existingFiles?: Map<string, string>) {
  files = existingFiles ?? new Map();
  (globalThis as Record<string, unknown>).tools = {
    glob: vi.fn(async ({ pattern }: { pattern: string }) => {
      const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
      const regex = new RegExp("^" + escaped.replace(/\*/g, "[^/]*") + "$");
      const matched = [...files.keys()].filter((f) => regex.test(f));
      return JSON.stringify(matched);
    }),
  };
}

beforeEach(() => {
  _resetForTesting();
  setupTools();
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("generateId", () => {
  it("returns a string matching t_ + 6 hex chars", () => {
    const id = generateId();
    expect(id).toMatch(/^t_[a-f0-9]{6}$/);
  });

  it("generates unique IDs", () => {
    const ids = new Set(Array.from({ length: 50 }, () => generateId()));
    expect(ids.size).toBeGreaterThan(1);
  });
});

describe("serializeJsonl / parseJsonl", () => {
  it("round-trips an array of row objects", () => {
    const rows = [
      { id: "a", file: "a.ts" },
      { id: "b", score: 42 },
    ];
    const jsonl = serializeJsonl(rows);
    expect(parseJsonl(jsonl)).toEqual(rows);
  });

  it("serializes one JSON object per line", () => {
    const rows = [{ id: "a" }, { id: "b" }];
    const lines = serializeJsonl(rows).split("\n");
    expect(lines).toHaveLength(2);
  });

  it("parseJsonl returns empty array for empty/whitespace content", () => {
    expect(parseJsonl("")).toEqual([]);
    expect(parseJsonl("  \n  ")).toEqual([]);
  });

  it("parseJsonl skips blank lines", () => {
    const content = '{"id":"a"}\n\n{"id":"b"}\n';
    expect(parseJsonl(content)).toEqual([{ id: "a" }, { id: "b" }]);
  });

  it("parseJsonl throws on malformed JSON", () => {
    expect(() => parseJsonl("not json")).toThrow("JSONL parse error at line 1");
  });

  it("parseJsonl throws on array line", () => {
    expect(() => parseJsonl("[1,2,3]")).toThrow("expected object");
  });

  it("parseJsonl throws on null line", () => {
    expect(() => parseJsonl("null")).toThrow("expected object");
  });

  it("parseJsonl includes line number in error for second line", () => {
    const content = '{"id":"a"}\nnot json';
    expect(() => parseJsonl(content)).toThrow("line 2");
  });
});

describe("pathsToRows", () => {
  it("uses basename as ID", () => {
    const rows = pathsToRows(["src/index.ts", "src/utils.ts"]);
    expect(rows).toEqual([
      { id: "index.ts", file: "src/index.ts" },
      { id: "utils.ts", file: "src/utils.ts" },
    ]);
  });

  it("disambiguates duplicate basenames with parent directory", () => {
    const rows = pathsToRows(["src/routes/index.ts", "src/handlers/index.ts"]);
    expect(rows[0].id).toBe("routes-index.ts");
    expect(rows[1].id).toBe("handlers-index.ts");
  });

  it("handles single-segment paths without disambiguation", () => {
    const rows = pathsToRows(["file.ts"]);
    expect(rows).toEqual([{ id: "file.ts", file: "file.ts" }]);
  });
});

// ---------------------------------------------------------------------------
// PTC wrappers
// ---------------------------------------------------------------------------

describe("globFiles", () => {
  it("parses string array responses", async () => {
    files.set("src/a.ts", "");
    const result = await globFiles("src/*.ts");
    expect(result).toEqual(["src/a.ts"]);
  });

  it("parses { path } object array responses", async () => {
    const tools = (globalThis as Record<string, unknown>).tools as Record<
      string,
      unknown
    >;
    tools.glob = vi.fn(async () =>
      JSON.stringify([{ path: "a.ts" }, { path: "b.ts" }]),
    );
    const result = await globFiles("**/*.ts");
    expect(result).toEqual(["a.ts", "b.ts"]);
  });

  it("throws when glob tool is not configured", async () => {
    (globalThis as Record<string, unknown>).tools = {};
    await expect(globFiles("*.ts")).rejects.toThrow("glob");
  });

  it("parses newline-separated path responses", async () => {
    const tools = (globalThis as Record<string, unknown>).tools as Record<
      string,
      unknown
    >;
    tools.glob = vi.fn(async () => "src/a.ts\nsrc/b.ts\nsrc/c.ts");
    const result = await globFiles("src/**/*.ts");
    expect(result).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
  });

  it("handles newline-separated paths with trailing newline", async () => {
    const tools = (globalThis as Record<string, unknown>).tools as Record<
      string,
      unknown
    >;
    tools.glob = vi.fn(async () => "a.ts\nb.ts\n");
    const result = await globFiles("**/*.ts");
    expect(result).toEqual(["a.ts", "b.ts"]);
  });

  it("returns empty array for no-match status string", async () => {
    const tools = (globalThis as Record<string, unknown>).tools as Record<
      string,
      unknown
    >;
    tools.glob = vi.fn(
      async () => "No files found matching pattern 'missing/**/*.ts'",
    );
    const result = await globFiles("missing/**/*.ts");
    expect(result).toEqual([]);
  });

  it("returns empty array for error status string", async () => {
    const tools = (globalThis as Record<string, unknown>).tools as Record<
      string,
      unknown
    >;
    tools.glob = vi.fn(async () => "Error finding files: permission denied");
    const result = await globFiles("restricted/**/*");
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// createTable
// ---------------------------------------------------------------------------

describe("createTable", () => {
  it("creates a table from filePaths", async () => {
    const handle = await createTable({
      filePaths: ["src/a.ts", "src/b.ts"],
    });
    expect(handle.count).toBe(2);
    expect(handle.columns).toEqual(["id", "file"]);
    expect(handle.id).toMatch(/^t_[a-f0-9]{6}$/);
  });

  it("creates a table from tasks", async () => {
    const handle = await createTable({
      tasks: [
        { id: "t1", text: "hello" },
        { id: "t2", text: "world" },
      ],
    });
    expect(handle.count).toBe(2);
    expect(handle.columns).toContain("id");
    expect(handle.columns).toContain("text");
  });

  it("creates a table from glob", async () => {
    const tools = (globalThis as Record<string, unknown>).tools as Record<
      string,
      unknown
    >;
    tools.glob = vi.fn(async () => JSON.stringify(["src/a.ts", "src/b.ts"]));

    const handle = await createTable({ glob: "src/**/*.ts" });
    expect(handle.count).toBe(2);
  });

  it("stores rows in memory", async () => {
    const handle = await createTable({
      tasks: [{ id: "t1", value: 1 }],
    });
    const rows = await loadTable(handle.id);
    expect(rows).toEqual([{ id: "t1", value: 1 }]);
  });

  it("throws when zero sources are provided", async () => {
    await expect(createTable({})).rejects.toThrow("exactly one source");
  });

  it("throws when multiple sources are provided", async () => {
    await expect(
      createTable({ filePaths: ["a.ts"], tasks: [{ id: "t1" }] }),
    ).rejects.toThrow("only one source");
  });

  it("throws when filePaths is empty", async () => {
    await expect(createTable({ filePaths: [] })).rejects.toThrow(
      "filePaths array is empty",
    );
  });

  it("throws when tasks is empty", async () => {
    await expect(createTable({ tasks: [] })).rejects.toThrow(
      "tasks array is empty",
    );
  });

  it("throws when a task is missing an id", async () => {
    await expect(createTable({ tasks: [{ name: "no id" }] })).rejects.toThrow(
      "missing string 'id' field",
    );
  });

  it("throws on duplicate row IDs", async () => {
    await expect(
      createTable({ tasks: [{ id: "dup" }, { id: "dup" }] }),
    ).rejects.toThrow("duplicate row ids");
  });
});

// ---------------------------------------------------------------------------
// loadTable
// ---------------------------------------------------------------------------

describe("loadTable", () => {
  it("returns rows from the in-memory store", async () => {
    const handle = await createTable({
      tasks: [{ id: "r1", val: "a" }],
    });
    const rows = await loadTable(handle.id);
    expect(rows).toEqual([{ id: "r1", val: "a" }]);
  });

  it("throws for a nonexistent table", async () => {
    await expect(loadTable("t_doesnt_exist")).rejects.toThrow("not found");
  });

  it("throws after cache reset (no backend fallback)", async () => {
    const handle = await createTable({
      tasks: [{ id: "r1", val: "a" }],
    });
    _resetForTesting();
    await expect(loadTable(handle.id)).rejects.toThrow("not found");
  });
});

// ---------------------------------------------------------------------------
// saveTable
// ---------------------------------------------------------------------------

describe("saveTable", () => {
  it("updates rows in memory", async () => {
    const handle = await createTable({
      tasks: [{ id: "r1", val: "a" }],
    });
    await saveTable(handle.id, [{ id: "r1", val: "a", result: "done" }]);

    const rows = await loadTable(handle.id);
    expect(rows).toEqual([{ id: "r1", val: "a", result: "done" }]);
  });

  it("throws when table is not loaded", async () => {
    await expect(saveTable("t_notloaded", [{ id: "r1" }])).rejects.toThrow(
      "not loaded",
    );
  });
});
