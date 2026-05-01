import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  generateId,
  tablePath,
  serializeJsonl,
  parseJsonl,
  extractIdFromPath,
  extractSeqFromPath,
  pathsToRows,
  globFiles,
  readFile,
  writeFile,
  createTable,
  loadTable,
  saveTable,
  _resetForTesting,
} from "./table.js";
import { SwarmHandle } from "./types.js";

// ---------------------------------------------------------------------------
// In-memory file system stub for PTC tools
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
    readFile: vi.fn(async ({ path }: { path: string }) => {
      const content = files.get(path);
      if (content === undefined) throw new Error(`File not found: ${path}`);
      return content;
    }),
    writeFile: vi.fn(
      async ({ path, content }: { path: string; content: string }) => {
        files.set(path, content);
        return "ok";
      },
    ),
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

describe("tablePath", () => {
  it("zero-pads the sequence number", () => {
    expect(tablePath(0, "t_abc123")).toBe(".swarm/000-t_abc123.jsonl");
    expect(tablePath(3, "t_abc123")).toBe(".swarm/003-t_abc123.jsonl");
    expect(tablePath(42, "t_abc123")).toBe(".swarm/042-t_abc123.jsonl");
    expect(tablePath(999, "t_abc123")).toBe(".swarm/999-t_abc123.jsonl");
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

describe("extractIdFromPath", () => {
  it("extracts the table ID from a valid path", () => {
    expect(extractIdFromPath(".swarm/003-t_a1b2c3.jsonl")).toBe("t_a1b2c3");
  });

  it("returns undefined for a non-matching filename", () => {
    expect(extractIdFromPath("random-file.txt")).toBeUndefined();
    expect(extractIdFromPath(".swarm/bad.jsonl")).toBeUndefined();
  });
});

describe("extractSeqFromPath", () => {
  it("extracts the sequence number from a valid path", () => {
    expect(extractSeqFromPath(".swarm/003-t_a1b2c3.jsonl")).toBe(3);
    expect(extractSeqFromPath(".swarm/042-t_abc123.jsonl")).toBe(42);
  });

  it("returns 0 for a non-matching filename", () => {
    expect(extractSeqFromPath("bad.jsonl")).toBe(0);
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
    files.set(".swarm/000-t_abc123.jsonl", "{}");
    const result = await globFiles(".swarm/*.jsonl");
    expect(result).toEqual([".swarm/000-t_abc123.jsonl"]);
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
});

describe("readFile", () => {
  it("returns file content", async () => {
    files.set("test.txt", "hello");
    expect(await readFile("test.txt")).toBe("hello");
  });

  it("throws when readFile tool is not configured", async () => {
    (globalThis as Record<string, unknown>).tools = {};
    await expect(readFile("test.txt")).rejects.toThrow("readFile");
  });
});

describe("writeFile", () => {
  it("writes content to the file store", async () => {
    await writeFile("out.txt", "data");
    expect(files.get("out.txt")).toBe("data");
  });

  it("throws when writeFile tool is not configured", async () => {
    (globalThis as Record<string, unknown>).tools = {};
    await expect(writeFile("out.txt", "data")).rejects.toThrow("writeFile");
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
    files.set(".swarm/placeholder", "");
    const tools = (globalThis as Record<string, unknown>).tools as Record<
      string,
      unknown
    >;
    tools.glob = vi.fn(async () => JSON.stringify(["src/a.ts", "src/b.ts"]));

    const handle = await createTable({ glob: "src/**/*.ts" });
    expect(handle.count).toBe(2);
  });

  it("persists the table as JSONL to the backend", async () => {
    const handle = await createTable({
      tasks: [{ id: "t1", value: 1 }],
    });
    const path = [...files.keys()].find((k) => k.includes(handle.id));
    expect(path).toBeDefined();
    const content = files.get(path as string);
    expect(content).toContain('"id":"t1"');
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
});

// ---------------------------------------------------------------------------
// loadTable
// ---------------------------------------------------------------------------

describe("loadTable", () => {
  it("returns rows from cache on cache hit", async () => {
    const handle = await createTable({
      tasks: [{ id: "r1", val: "a" }],
    });
    const rows = await loadTable(handle.id);
    expect(rows).toEqual([{ id: "r1", val: "a" }]);
  });

  it("reads from backend on cache miss", async () => {
    const handle = await createTable({
      tasks: [{ id: "r1", val: "a" }],
    });
    _resetForTesting();
    setupTools(files);

    const rows = await loadTable(handle.id);
    expect(rows).toEqual([{ id: "r1", val: "a" }]);
  });

  it("throws for a nonexistent table", async () => {
    await expect(loadTable("t_doesnt_exist")).rejects.toThrow("not found");
  });

  it("throws for an evicted table (empty file)", async () => {
    files.set(".swarm/000-t_evicted.jsonl", "");
    await expect(loadTable("t_evicted")).rejects.toThrow("evicted");
  });
});

// ---------------------------------------------------------------------------
// saveTable
// ---------------------------------------------------------------------------

describe("saveTable", () => {
  it("persists updated rows to the backend", async () => {
    const handle = await createTable({
      tasks: [{ id: "r1", val: "a" }],
    });
    await saveTable(handle.id, [{ id: "r1", val: "a", result: "done" }]);

    const path = [...files.keys()].find((k) => k.includes(handle.id));
    const content = files.get(path as string);
    expect(content).toContain('"result":"done"');
  });

  it("throws when table is not loaded", async () => {
    await expect(saveTable("t_notloaded", [{ id: "r1" }])).rejects.toThrow(
      "not loaded",
    );
  });
});

// ---------------------------------------------------------------------------
// Eviction
// ---------------------------------------------------------------------------

describe("eviction", () => {
  it("evicts oldest tables when count exceeds MAX_TABLES", async () => {
    const handles: SwarmHandle[] = [];
    for (let i = 0; i < 6; i++) {
      handles.push(await createTable({ tasks: [{ id: `row-${i}` }] }));
    }

    const firstPath = [...files.keys()].find((k) => k.includes(handles[0].id));
    expect(firstPath).toBeDefined();
    expect(files.get(firstPath as string)).toBe("");
  });

  it("evicted tables are not loadable", async () => {
    const handles = [];
    for (let i = 0; i < 6; i++) {
      handles.push(await createTable({ tasks: [{ id: `row-${i}` }] }));
    }

    _resetForTesting();
    setupTools(files);

    await expect(loadTable(handles[0].id)).rejects.toThrow("evicted");
  });
});

// ---------------------------------------------------------------------------
// Sequence numbering
// ---------------------------------------------------------------------------

describe("sequence numbering", () => {
  it("avoids collisions across cache resets", async () => {
    await createTable({ tasks: [{ id: "r1" }] });
    await createTable({ tasks: [{ id: "r2" }] });

    _resetForTesting();
    setupTools(files);

    const handle = await createTable({ tasks: [{ id: "r3" }] });
    const path = [...files.keys()].find((k) => k.includes(handle.id));
    expect(path).toBeDefined();
    expect(path).toMatch(/^\.swarm\/00[2-9]/);
  });
});
