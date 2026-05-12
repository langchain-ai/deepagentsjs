import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

import { describe, it, expect, vi } from "vitest";
import type { Client } from "langsmith";
import type { Entry } from "langsmith/schemas";

import { ContextHubBackend } from "./context-hub.js";
import { CompositeBackend } from "./composite.js";
import { FilesystemBackend } from "./filesystem.js";

const COMMIT_HASH = "abcd1234".repeat(8);
const COMMIT_URL = "https://host/hub/-/test-agent:ef567890";

function makeLangSmithError(
  message: string,
  options: { name?: string; status?: number } = {},
): Error & { status?: number } {
  const error = new Error(message) as Error & { status?: number };
  if (options.name) {
    Object.defineProperty(error, "name", { value: options.name });
  }
  if (options.status !== undefined) {
    error.status = options.status;
  }
  return error;
}

function makeBackend(files: Record<string, Entry> = {}): {
  backend: ContextHubBackend;
  client: {
    pullAgent: ReturnType<typeof vi.fn>;
    pushAgent: ReturnType<typeof vi.fn>;
  };
} {
  const client = {
    pullAgent: vi.fn().mockResolvedValue({
      commit_id: "00000000-0000-0000-0000-000000000000",
      commit_hash: COMMIT_HASH,
      files,
    }),
    pushAgent: vi.fn().mockResolvedValue(COMMIT_URL),
  };

  const backend = new ContextHubBackend("-/test-agent", {
    client: client as unknown as Client,
  });
  return { backend, client };
}

describe("ContextHubBackend", () => {
  it("read returns file content", async () => {
    const { backend } = makeBackend({
      "AGENTS.md": { type: "file", content: "# hi\nworld" },
    });

    const result = await backend.read("/AGENTS.md");
    expect(result.error).toBeUndefined();
    expect(result.content).toBe("# hi\nworld");
    expect(result.mimeType).toBe("text/plain");
  });

  it("read missing file returns not found", async () => {
    const { backend } = makeBackend();
    const result = await backend.read("/missing.md");
    expect(result.error).toBe("File '/missing.md' not found");
    expect(result.content).toBeUndefined();
  });

  it("read applies offset and limit", async () => {
    const { backend } = makeBackend({
      "a.md": { type: "file", content: "1\n2\n3\n4\n5" },
    });

    const result = await backend.read("/a.md", 1, 2);
    expect(result.error).toBeUndefined();
    expect(result.content).toBe("2\n3\n");
  });

  it("read offset beyond file length returns an error", async () => {
    const { backend } = makeBackend({
      "a.md": { type: "file", content: "1\n2" },
    });

    const result = await backend.read("/a.md", 5, 10);
    expect(result.error).toBe("Line offset 5 exceeds file length (2 lines)");
    expect(result.content).toBeUndefined();
  });

  it("pull runs once for repeated reads", async () => {
    const { backend, client } = makeBackend({
      "a.md": { type: "file", content: "a" },
    });

    await backend.read("/a.md");
    await backend.read("/a.md");
    await backend.ls("/");
    expect(client.pullAgent).toHaveBeenCalledTimes(1);
  });

  it("pull 404 is treated as an empty repo", async () => {
    const client = {
      pullAgent: vi.fn().mockRejectedValue(
        makeLangSmithError("not found", {
          name: "LangSmithNotFoundError",
          status: 404,
        }),
      ),
      pushAgent: vi.fn().mockResolvedValue(COMMIT_URL),
    };
    const backend = new ContextHubBackend("-/new-agent", {
      client: client as unknown as Client,
    });

    const result = await backend.read("/any.md");
    expect(result.error).toBe("File '/any.md' not found");
  });

  it("pull non-404 LangSmith failures surface as hub errors", async () => {
    const client = {
      pullAgent: vi.fn().mockRejectedValue(
        makeLangSmithError("hub 5xx", {
          name: "LangSmithAPIError",
          status: 500,
        }),
      ),
      pushAgent: vi.fn().mockResolvedValue(COMMIT_URL),
    };
    const backend = new ContextHubBackend("-/x", {
      client: client as unknown as Client,
    });

    const result = await backend.read("/anything");
    expect(result.error).toContain("Hub unavailable");
    expect(result.error).toContain("hub 5xx");
  });

  it("unexpected non-LangSmith pull failures propagate", async () => {
    const client = {
      pullAgent: vi.fn().mockRejectedValue(new Error("boom")),
      pushAgent: vi.fn().mockResolvedValue(COMMIT_URL),
    };
    const backend = new ContextHubBackend("-/x", {
      client: client as unknown as Client,
    });

    await expect(backend.read("/anything")).rejects.toThrow("boom");
  });

  it("hasPriorCommits is false for missing repo", async () => {
    const client = {
      pullAgent: vi.fn().mockRejectedValue(
        makeLangSmithError("not found", {
          name: "LangSmithNotFoundError",
          status: 404,
        }),
      ),
      pushAgent: vi.fn().mockResolvedValue(COMMIT_URL),
    };
    const backend = new ContextHubBackend("-/fresh", {
      client: client as unknown as Client,
    });

    await expect(backend.hasPriorCommits()).resolves.toBe(false);
  });

  it("hasPriorCommits is true for an existing repo", async () => {
    const { backend } = makeBackend({
      "a.md": { type: "file", content: "a" },
    });
    await expect(backend.hasPriorCommits()).resolves.toBe(true);
  });

  it("hasPriorCommits flips true after first write", async () => {
    const client = {
      pullAgent: vi.fn().mockRejectedValue(
        makeLangSmithError("not found", {
          name: "LangSmithNotFoundError",
          status: 404,
        }),
      ),
      pushAgent: vi.fn().mockResolvedValue(COMMIT_URL),
    };
    const backend = new ContextHubBackend("-/fresh", {
      client: client as unknown as Client,
    });

    expect(await backend.hasPriorCommits()).toBe(false);
    await backend.write("/seed.md", "hello");
    expect(await backend.hasPriorCommits()).toBe(true);
  });

  it("write commits file content", async () => {
    const { backend, client } = makeBackend();
    const result = await backend.write("/notes.md", "# hi");

    expect(result.error).toBeUndefined();
    expect(result.path).toBe("/notes.md");
    expect(client.pushAgent).toHaveBeenCalledTimes(1);

    const [, options] = client.pushAgent.mock.calls[0];
    expect(options.files).toHaveProperty("notes.md");
    expect(options.files["notes.md"]).toEqual({
      type: "file",
      content: "# hi",
    });
  });

  it("write sends parent commit from pull", async () => {
    const { backend, client } = makeBackend({
      "a.md": { type: "file", content: "a" },
    });
    await backend.read("/a.md");
    await backend.write("/b.md", "b");

    const [, options] = client.pushAgent.mock.calls[0];
    expect(options.parentCommit).toBe(COMMIT_HASH);
  });

  it("write updates commit hash from push URL", async () => {
    const { backend, client } = makeBackend();
    await backend.write("/a.md", "a");
    await backend.write("/b.md", "b");

    const [, options] = client.pushAgent.mock.calls[1];
    expect(options.parentCommit).toBe("ef567890");
  });

  it("write updates cache after commit", async () => {
    const { backend } = makeBackend();
    await backend.write("/a.md", "hello");

    const result = await backend.read("/a.md");
    expect(result.error).toBeUndefined();
    expect(result.content).toBe("hello");
  });

  it("write allows sibling paths under linked entries", async () => {
    const { backend, client } = makeBackend({
      "skills/code-reviewer": { type: "skill", repo_handle: "code-reviewer" },
    });

    const result = await backend.write("/skills/code-reviewer.md", "sibling");
    expect(result.error).toBeUndefined();
    expect(client.pushAgent).toHaveBeenCalledTimes(1);
  });

  it("commit failures invalidate cache and re-pull on next read", async () => {
    const { backend, client } = makeBackend({
      "a.md": { type: "file", content: "a" },
    });
    client.pushAgent.mockRejectedValue(
      makeLangSmithError("500", { name: "LangSmithAPIError", status: 500 }),
    );

    const result = await backend.write("/b.md", "b");
    expect(result.error).toContain("Hub unavailable");

    await backend.read("/a.md");
    expect(client.pullAgent).toHaveBeenCalledTimes(2);
  });

  it("edit replaces a single occurrence", async () => {
    const { backend, client } = makeBackend({
      "a.md": { type: "file", content: "hello world" },
    });

    const result = await backend.edit("/a.md", "world", "earth");
    expect(result.error).toBeUndefined();
    expect(result.occurrences).toBe(1);

    const [, options] = client.pushAgent.mock.calls[0];
    expect(options.files["a.md"]).toEqual({
      type: "file",
      content: "hello earth",
    });
  });

  it("edit returns not found when target file does not exist", async () => {
    const { backend } = makeBackend();
    const result = await backend.edit("/missing.md", "x", "y");
    expect(result.error).toContain("not found");
  });

  it("edit returns ambiguity error when replaceAll is false", async () => {
    const { backend } = makeBackend({
      "a.md": { type: "file", content: "x x x" },
    });

    const result = await backend.edit("/a.md", "x", "y");
    expect(result.error).toContain("multiple occurrences");
  });

  it("edit with replaceAll replaces all matches", async () => {
    const { backend } = makeBackend({
      "a.md": { type: "file", content: "x x x" },
    });

    const result = await backend.edit("/a.md", "x", "y", true);
    expect(result.error).toBeUndefined();
    expect(result.occurrences).toBe(3);
  });

  it("ls supports flat and nested repos", async () => {
    const { backend } = makeBackend({
      "AGENTS.md": { type: "file", content: "a" },
      "memories/day1.md": { type: "file", content: "m1" },
      "memories/day2.md": { type: "file", content: "m2" },
    });

    const root = await backend.ls("/");
    const rootPaths = new Set((root.files ?? []).map((file) => file.path));
    expect(rootPaths.has("/AGENTS.md")).toBe(true);
    expect(rootPaths.has("/memories")).toBe(true);

    const nested = await backend.ls("/memories");
    const nestedPaths = (nested.files ?? []).map((file) => file.path).sort();
    expect(nestedPaths).toEqual(["/memories/day1.md", "/memories/day2.md"]);
  });

  it("ls surfaces pull errors", async () => {
    const client = {
      pullAgent: vi
        .fn()
        .mockRejectedValue(
          makeLangSmithError("5xx", { name: "LangSmithAPIError", status: 500 }),
        ),
      pushAgent: vi.fn().mockResolvedValue(COMMIT_URL),
    };
    const backend = new ContextHubBackend("-/x", {
      client: client as unknown as Client,
    });

    const result = await backend.ls("/");
    expect(result.error).toContain("Hub unavailable");
  });

  it("grep finds matches and supports path prefixes", async () => {
    const { backend } = makeBackend({
      "memories/a.md": { type: "file", content: "hello" },
      "AGENTS.md": { type: "file", content: "hello" },
    });

    const result = await backend.grep("hello", "/memories");
    const paths = new Set((result.matches ?? []).map((match) => match.path));
    expect(paths).toEqual(new Set(["/memories/a.md"]));
  });

  it("grep treats regex metacharacters as literal text", async () => {
    const { backend } = makeBackend({
      "a.md": { type: "file", content: "literal [unclosed\nother line" },
    });

    const result = await backend.grep("[unclosed");
    expect(result.error).toBeUndefined();
    expect(result.matches).toEqual([
      { path: "/a.md", line: 1, text: "literal [unclosed" },
    ]);
  });

  it("glob matches file patterns", async () => {
    const { backend } = makeBackend({
      "a.md": { type: "file", content: "x" },
      "b.txt": { type: "file", content: "y" },
      "c.md": { type: "file", content: "z" },
    });

    const result = await backend.glob("*.md");
    const paths = (result.files ?? []).map((file) => file.path).sort();
    expect(paths).toEqual(["/a.md", "/c.md"]);
  });

  it("glob ignores path argument and matches nested files like Python fnmatch", async () => {
    const { backend } = makeBackend({
      "a.md": { type: "file", content: "a" },
      "nested/b.md": { type: "file", content: "b" },
      "nested/c.txt": { type: "file", content: "c" },
    });

    const result = await backend.glob("*.md", "/nested");
    const paths = (result.files ?? []).map((file) => file.path).sort();
    expect(paths).toEqual(["/a.md", "/nested/b.md"]);
  });

  it("grep glob follows Python fnmatch semantics for nested paths", async () => {
    const { backend } = makeBackend({
      "root.md": { type: "file", content: "hello" },
      "nested/a.md": { type: "file", content: "hello" },
      "nested/b.txt": { type: "file", content: "hello" },
    });

    const result = await backend.grep("hello", null, "*.md");
    const paths = new Set((result.matches ?? []).map((match) => match.path));
    expect(paths).toEqual(new Set(["/nested/a.md", "/root.md"]));
  });

  it("upload supports partial success and single-commit batching", async () => {
    const { backend, client } = makeBackend();

    const responses = await backend.uploadFiles([
      ["/ok.md", new TextEncoder().encode("hello")],
      ["/bad.bin", new Uint8Array([0x80])],
      ["/also-ok.md", new TextEncoder().encode("world")],
    ]);

    expect(responses[0].error).toBeNull();
    expect(responses[1].error).toBe("invalid_path");
    expect(responses[2].error).toBeNull();
    expect(client.pushAgent).toHaveBeenCalledTimes(1);

    const [, options] = client.pushAgent.mock.calls[0];
    expect(new Set(Object.keys(options.files))).toEqual(
      new Set(["ok.md", "also-ok.md"]),
    );
  });

  it("upload commit failures propagate to valid files", async () => {
    const { backend, client } = makeBackend();
    client.pushAgent.mockRejectedValue(
      makeLangSmithError("503", { name: "LangSmithAPIError", status: 503 }),
    );

    const responses = await backend.uploadFiles([
      ["/a.md", new TextEncoder().encode("alpha")],
      ["/b.md", new TextEncoder().encode("beta")],
      ["/bad.bin", new Uint8Array([0x80])],
    ]);

    expect(responses[0].error).toBe("invalid_path");
    expect(responses[1].error).toBe("invalid_path");
    expect(responses[2].error).toBe("invalid_path");
    expect(client.pushAgent).toHaveBeenCalledTimes(1);
  });

  it("upload commit permission failures map to permission_denied", async () => {
    const { backend, client } = makeBackend();
    client.pushAgent.mockRejectedValue(
      makeLangSmithError("forbidden", {
        name: "LangSmithAuthError",
        status: 403,
      }),
    );

    const responses = await backend.uploadFiles([
      ["/a.md", new TextEncoder().encode("alpha")],
      ["/b.md", new TextEncoder().encode("beta")],
    ]);

    expect(responses[0].error).toBe("permission_denied");
    expect(responses[1].error).toBe("permission_denied");
  });

  it("upload duplicate path keeps last write", async () => {
    const { backend, client } = makeBackend();
    await backend.uploadFiles([
      ["/dup.md", new TextEncoder().encode("first")],
      ["/dup.md", new TextEncoder().encode("second")],
    ]);

    const [, options] = client.pushAgent.mock.calls[0];
    expect(options.files["dup.md"]).toEqual({
      type: "file",
      content: "second",
    });
  });

  it("download returns bytes for existing files and file_not_found for missing", async () => {
    const { backend } = makeBackend({
      "a.md": { type: "file", content: "hi" },
    });

    const responses = await backend.downloadFiles(["/a.md", "/nope.md"]);
    expect(new TextDecoder().decode(responses[0].content!)).toBe("hi");
    expect(responses[0].error).toBeNull();
    expect(responses[1].error).toBe("file_not_found");
  });

  it("download propagates pull failures", async () => {
    const client = {
      pullAgent: vi
        .fn()
        .mockRejectedValue(
          makeLangSmithError("5xx", { name: "LangSmithAPIError", status: 500 }),
        ),
      pushAgent: vi.fn().mockResolvedValue(COMMIT_URL),
    };
    const backend = new ContextHubBackend("-/x", {
      client: client as unknown as Client,
    });

    const responses = await backend.downloadFiles(["/a.md"]);
    expect(responses[0].error).toBe("invalid_path");
  });

  it("download permission failures map to permission_denied", async () => {
    const client = {
      pullAgent: vi.fn().mockRejectedValue(
        makeLangSmithError("forbidden", {
          name: "LangSmithAuthError",
          status: 403,
        }),
      ),
      pushAgent: vi.fn().mockResolvedValue(COMMIT_URL),
    };
    const backend = new ContextHubBackend("-/x", {
      client: client as unknown as Client,
    });

    const responses = await backend.downloadFiles(["/a.md", "/b.md"]);
    expect(responses[0].error).toBe("permission_denied");
    expect(responses[1].error).toBe("permission_denied");
  });

  it("getLinkedEntries returns linked repo handles", async () => {
    const { backend } = makeBackend({
      "skills/reviewer": { type: "skill", repo_handle: "reviewer" },
      "subagents/planner": { type: "agent", repo_handle: "planner" },
      "AGENTS.md": { type: "file", content: "a" },
    });

    await expect(backend.getLinkedEntries()).resolves.toEqual({
      "skills/reviewer": "reviewer",
      "subagents/planner": "planner",
    });
  });

  it("files expanded under linked paths remain readable", async () => {
    const { backend } = makeBackend({
      "skills/s": { type: "skill", repo_handle: "s" },
      "skills/s/skill.md": { type: "file", content: "expanded" },
    });

    const result = await backend.read("/skills/s/skill.md");
    expect(result.error).toBeUndefined();
    expect(result.content).toBe("expanded");
  });

  it("composite routing strips and restores route prefixes", async () => {
    const tempDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "deepagents-context-hub-composite-"),
    );
    try {
      const { backend: hubBackend, client } = makeBackend();
      const defaultBackend = new FilesystemBackend({
        rootDir: tempDir,
        virtualMode: true,
      });
      const composite = new CompositeBackend(defaultBackend, {
        "/memories/": hubBackend,
      });

      await composite.write("/memories/notes.md", "hello hub");
      const [, options] = client.pushAgent.mock.calls[0];
      expect(options.files["notes.md"]).toEqual({
        type: "file",
        content: "hello hub",
      });

      const read = await composite.read("/memories/notes.md");
      expect(read.error).toBeUndefined();
      expect(read.content).toContain("hello hub");

      await composite.write("/fs-only.txt", "default side");
      expect(client.pushAgent).toHaveBeenCalledTimes(1);
      expect(
        await fs.readFile(path.join(tempDir, "fs-only.txt"), "utf-8"),
      ).toBe("default side");

      const lsMem = await composite.ls("/memories/");
      expect(
        lsMem.files?.some((file) => file.path === "/memories/notes.md"),
      ).toBe(true);

      const grepMem = await composite.grep("hello", "/memories");
      expect(
        grepMem.matches?.some((match) => match.path === "/memories/notes.md"),
      ).toBe(true);

      const globMem = await composite.glob("*.md", "/memories");
      expect(
        globMem.files?.some((file) => file.path === "/memories/notes.md"),
      ).toBe(true);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
