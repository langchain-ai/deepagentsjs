import { describe, it, expect, vi } from "vitest";
import { createTable, type WriteCallback } from "./table.js";
import type { BackendProtocolV2 } from "../backends/v2/protocol.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeBackend(files: Record<string, string[]> = {}): BackendProtocolV2 {
  return {
    glob: vi.fn(async (pattern: string) => {
      const matched = files[pattern];
      if (matched === undefined) {
        return { files: [] };
      }
      return { files: matched.map((path) => ({ path })) };
    }),
  } as unknown as BackendProtocolV2;
}

function makeWrite(): {
  write: WriteCallback;
  calls: Array<{ path: string; content: string }>;
} {
  const calls: Array<{ path: string; content: string }> = [];
  const write: WriteCallback = (path, content) => calls.push({ path, content });
  return { write, calls };
}

function parseRows(content: string): Record<string, unknown>[] {
  return content
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l));
}

// ─── tasks form ──────────────────────────────────────────────────────────────

describe("createTable — tasks form", () => {
  it("writes pre-built rows directly to the file", async () => {
    const { write, calls } = makeWrite();
    const tasks = [
      { id: "r1", text: "alpha" },
      { id: "r2", text: "beta" },
    ];
    await createTable("/out.jsonl", { tasks }, makeBackend(), write);

    expect(calls).toHaveLength(1);
    expect(calls[0].path).toBe("/out.jsonl");
    const rows = parseRows(calls[0].content);
    expect(rows).toEqual(tasks);
  });

  it("throws when any task is missing an id field", async () => {
    const { write } = makeWrite();
    await expect(
      createTable(
        "/out.jsonl",
        { tasks: [{ id: "r1" }, { text: "no id" }, { text: "also no id" }] },
        makeBackend(),
        write,
      ),
    ).rejects.toThrow('tasks at index 1, 2 missing required "id" field');
  });

  it("throws when the id field is not a string", async () => {
    const { write } = makeWrite();
    await expect(
      createTable("/out.jsonl", { tasks: [{ id: 42 }] }, makeBackend(), write),
    ).rejects.toThrow('tasks at index 0 missing required "id" field');
  });

  it("does not call the backend glob when tasks are provided", async () => {
    const backend = makeBackend();
    const { write } = makeWrite();
    await createTable("/out.jsonl", { tasks: [{ id: "r1" }] }, backend, write);
    expect(backend.glob).not.toHaveBeenCalled();
  });
});

// ─── filePaths form ───────────────────────────────────────────────────────────

describe("createTable — filePaths form", () => {
  it("writes one { id, file } row per path", async () => {
    const { write, calls } = makeWrite();
    await createTable(
      "/out.jsonl",
      { filePaths: ["/data/a.txt", "/data/b.txt"] },
      makeBackend(),
      write,
    );

    const rows = parseRows(calls[0].content);
    expect(rows).toEqual([
      { id: "a.txt", file: "/data/a.txt" },
      { id: "b.txt", file: "/data/b.txt" },
    ]);
  });

  it("deduplicates basename collisions by prepending parent directory", async () => {
    const { write, calls } = makeWrite();
    await createTable(
      "/out.jsonl",
      { filePaths: ["/dirA/report.txt", "/dirB/report.txt"] },
      makeBackend(),
      write,
    );

    const rows = parseRows(calls[0].content);
    expect(rows).toEqual([
      { id: "dirA-report.txt", file: "/dirA/report.txt" },
      { id: "dirB-report.txt", file: "/dirB/report.txt" },
    ]);
  });

  it("does not mangle unique basenames even when other basenames collide", async () => {
    const { write, calls } = makeWrite();
    await createTable(
      "/out.jsonl",
      { filePaths: ["/a/dup.txt", "/b/dup.txt", "/c/unique.txt"] },
      makeBackend(),
      write,
    );

    const rows = parseRows(calls[0].content);
    const ids = rows.map((r) => r.id);
    expect(ids).toContain("a-dup.txt");
    expect(ids).toContain("b-dup.txt");
    expect(ids).toContain("unique.txt");
  });

  it("sorts rows by path", async () => {
    const { write, calls } = makeWrite();
    await createTable(
      "/out.jsonl",
      { filePaths: ["/z.txt", "/a.txt", "/m.txt"] },
      makeBackend(),
      write,
    );

    const rows = parseRows(calls[0].content);
    expect(rows.map((r) => r.file)).toEqual(["/a.txt", "/m.txt", "/z.txt"]);
  });
});

// ─── glob form ────────────────────────────────────────────────────────────────

describe("createTable — glob form", () => {
  it("resolves glob via backend and writes one row per matched file", async () => {
    const backend = makeBackend({
      "data/*.txt": ["/data/a.txt", "/data/b.txt"],
    });
    const { write, calls } = makeWrite();
    await createTable("/out.jsonl", { glob: "data/*.txt" }, backend, write);

    const rows = parseRows(calls[0].content);
    expect(rows).toEqual([
      { id: "a.txt", file: "/data/a.txt" },
      { id: "b.txt", file: "/data/b.txt" },
    ]);
  });

  it("strips leading slash from glob pattern before passing to backend", async () => {
    const backend = makeBackend({ "data/*.txt": ["/data/a.txt"] });
    const { write } = makeWrite();
    await createTable("/out.jsonl", { glob: "/data/*.txt" }, backend, write);
    expect(backend.glob).toHaveBeenCalledWith("data/*.txt");
  });

  it("accepts an array of glob patterns and merges results", async () => {
    const backend = makeBackend({
      "a/*.txt": ["/a/one.txt"],
      "b/*.txt": ["/b/two.txt"],
    });
    const { write, calls } = makeWrite();
    await createTable(
      "/out.jsonl",
      { glob: ["a/*.txt", "b/*.txt"] },
      backend,
      write,
    );

    const rows = parseRows(calls[0].content);
    expect(rows).toHaveLength(2);
  });

  it("deduplicates paths matched by multiple patterns", async () => {
    const backend = makeBackend({
      "a/*.txt": ["/shared/file.txt"],
      "b/*.txt": ["/shared/file.txt"],
    });
    const { write, calls } = makeWrite();
    await createTable(
      "/out.jsonl",
      { glob: ["a/*.txt", "b/*.txt"] },
      backend,
      write,
    );

    const rows = parseRows(calls[0].content);
    expect(rows).toHaveLength(1);
  });

  it("throws when the glob returns no files", async () => {
    const backend = makeBackend({ "empty/*.txt": [] });
    const { write } = makeWrite();
    await expect(
      createTable("/out.jsonl", { glob: "empty/*.txt" }, backend, write),
    ).rejects.toThrow("No files matched");
  });

  it("throws when the backend returns an error for the glob pattern", async () => {
    const backend = {
      glob: vi.fn(async () => ({ error: "permission denied" })),
    } as unknown as BackendProtocolV2;
    const { write } = makeWrite();
    await expect(
      createTable("/out.jsonl", { glob: "bad/*.txt" }, backend, write),
    ).rejects.toThrow('Glob pattern "bad/*.txt" failed: permission denied');
  });
});

// ─── mixed filePaths + glob ───────────────────────────────────────────────────

describe("createTable — mixed filePaths + glob", () => {
  it("combines explicit paths with glob results", async () => {
    const backend = makeBackend({ "extra/*.txt": ["/extra/c.txt"] });
    const { write, calls } = makeWrite();
    await createTable(
      "/out.jsonl",
      { filePaths: ["/a.txt"], glob: "extra/*.txt" },
      backend,
      write,
    );

    const rows = parseRows(calls[0].content);
    const files = rows.map((r) => r.file);
    expect(files).toContain("/a.txt");
    expect(files).toContain("/extra/c.txt");
  });
});

// ─── empty source ─────────────────────────────────────────────────────────────

describe("createTable — empty source", () => {
  it("throws when no source is provided", async () => {
    const { write } = makeWrite();
    await expect(
      createTable("/out.jsonl", {}, makeBackend(), write),
    ).rejects.toThrow("source must provide at least one of");
  });

  it("throws when tasks is an empty array", async () => {
    const { write } = makeWrite();
    await expect(
      createTable("/out.jsonl", { tasks: [] }, makeBackend(), write),
    ).rejects.toThrow("source must provide at least one of");
  });

  it("throws when filePaths is an empty array", async () => {
    const { write } = makeWrite();
    await expect(
      createTable("/out.jsonl", { filePaths: [] }, makeBackend(), write),
    ).rejects.toThrow("source must provide at least one of");
  });
});

// ─── overwrite ────────────────────────────────────────────────────────────────

describe("createTable — overwrite behaviour", () => {
  it("calls write with the new content on each invocation (overwrite semantics)", async () => {
    const backend = makeBackend();
    const { write, calls } = makeWrite();

    await createTable("/t.jsonl", { tasks: [{ id: "v1" }] }, backend, write);
    await createTable(
      "/t.jsonl",
      { tasks: [{ id: "v2" }, { id: "v3" }] },
      backend,
      write,
    );

    expect(calls).toHaveLength(2);
    expect(parseRows(calls[1].content)).toHaveLength(2);
  });
});
