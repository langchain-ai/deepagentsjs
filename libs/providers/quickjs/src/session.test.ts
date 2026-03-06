import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tool } from "langchain";
import { z } from "zod/v4";
import type { BackendProtocol, FileData, WriteResult } from "deepagents";
import { ReplSession } from "./session.js";

const TIMEOUT = 5000;
let nextId = 0;

function uniqueThreadId() {
  return `test-${++nextId}-${Date.now()}`;
}

function createMockBackend(
  files: Record<string, string> = {},
): BackendProtocol & { written: Record<string, string> } {
  const store = { ...files };
  const written: Record<string, string> = {};

  return {
    written,
    lsInfo: async () => [],
    read: async (filePath: string) => store[filePath] ?? "",
    readRaw: async (filePath: string): Promise<FileData> => {
      if (!(filePath in store)) {
        throw new Error(`ENOENT: ${filePath}`);
      }
      const now = new Date().toISOString();
      return {
        content: store[filePath].split("\n"),
        created_at: now,
        modified_at: now,
      };
    },
    grepRaw: async () => [],
    globInfo: async () => [],
    write: async (filePath: string, content: string): Promise<WriteResult> => {
      store[filePath] = content;
      written[filePath] = content;
      return { path: filePath };
    },
    edit: async () => ({ error: "not implemented" }),
  };
}

describe("REPL Engine", () => {
  let session: ReplSession;

  beforeEach(() => {
    ReplSession.clearCache();
  });

  afterEach(() => {
    if (session) session.dispose();
  });

  describe("basic evaluation", () => {
    it("should evaluate simple expressions", async () => {
      session = ReplSession.getOrCreate(uniqueThreadId());
      const result = await session.eval("1 + 2", TIMEOUT);
      expect(result.ok).toBe(true);
      expect(result.value).toBe(3);
    });

    it("should return strings", async () => {
      session = ReplSession.getOrCreate(uniqueThreadId());
      const result = await session.eval('"hello"', TIMEOUT);
      expect(result.ok).toBe(true);
      expect(result.value).toBe("hello");
    });

    it("should return objects", async () => {
      session = ReplSession.getOrCreate(uniqueThreadId());
      const result = await session.eval('({ a: 1, b: "two" })', TIMEOUT);
      expect(result.ok).toBe(true);
      expect(result.value).toEqual({ a: 1, b: "two" });
    });

    it("should return arrays", async () => {
      session = ReplSession.getOrCreate(uniqueThreadId());
      const result = await session.eval("[1, 2, 3]", TIMEOUT);
      expect(result.ok).toBe(true);
      expect(result.value).toEqual([1, 2, 3]);
    });
  });

  describe("state persistence", () => {
    it("should persist variables across evaluations", async () => {
      session = ReplSession.getOrCreate(uniqueThreadId());
      await session.eval("var counter = 0", TIMEOUT);
      await session.eval("counter++", TIMEOUT);
      await session.eval("counter++", TIMEOUT);
      const result = await session.eval("counter", TIMEOUT);
      expect(result.value).toBe(2);
    });

    it("should persist functions", async () => {
      session = ReplSession.getOrCreate(uniqueThreadId());
      await session.eval("function double(x) { return x * 2; }", TIMEOUT);
      const result = await session.eval("double(21)", TIMEOUT);
      expect(result.value).toBe(42);
    });

    it("should persist closures", async () => {
      session = ReplSession.getOrCreate(uniqueThreadId());
      await session.eval(
        "var makeCounter = function() { var n = 0; return function() { return n++; }; }",
        TIMEOUT,
      );
      await session.eval("var c = makeCounter()", TIMEOUT);
      await session.eval("c()", TIMEOUT);
      await session.eval("c()", TIMEOUT);
      const result = await session.eval("c()", TIMEOUT);
      expect(result.value).toBe(2);
    });
  });

  describe("console output", () => {
    it("should capture console.log", async () => {
      session = ReplSession.getOrCreate(uniqueThreadId());
      const result = await session.eval('console.log("hello"); 42', TIMEOUT);
      expect(result.logs).toEqual(["hello"]);
      expect(result.value).toBe(42);
    });

    it("should label console.warn and console.error", async () => {
      session = ReplSession.getOrCreate(uniqueThreadId());
      const result = await session.eval(
        'console.warn("w"); console.error("e")',
        TIMEOUT,
      );
      expect(result.logs).toContain("[warn] w");
      expect(result.logs).toContain("[error] e");
    });

    it("should clear logs between evaluations", async () => {
      session = ReplSession.getOrCreate(uniqueThreadId());
      await session.eval('console.log("first")', TIMEOUT);
      const result = await session.eval('console.log("second")', TIMEOUT);
      expect(result.logs).toEqual(["second"]);
    });
  });

  describe("error handling", () => {
    it("should report syntax errors", async () => {
      session = ReplSession.getOrCreate(uniqueThreadId());
      const result = await session.eval("function(", TIMEOUT);
      expect(result.ok).toBe(false);
      expect(result.error).toBeDefined();
    });

    it("should report runtime errors", async () => {
      session = ReplSession.getOrCreate(uniqueThreadId());
      const result = await session.eval("undefinedVar.prop", TIMEOUT);
      expect(result.ok).toBe(false);
    });

    it("should preserve state after errors", async () => {
      session = ReplSession.getOrCreate(uniqueThreadId());
      await session.eval("var x = 42", TIMEOUT);
      await session.eval('throw new Error("oops")', TIMEOUT);
      const result = await session.eval("x", TIMEOUT);
      expect(result.value).toBe(42);
    });
  });

  describe("execution limits", () => {
    it("should timeout on infinite loops", async () => {
      session = ReplSession.getOrCreate(uniqueThreadId());
      const result = await session.eval("while(true) {}", 200);
      expect(result.ok).toBe(false);
      expect(result.error?.message).toContain("interrupted");
    });
  });

  describe("sandbox isolation", () => {
    it("should not expose process", async () => {
      session = ReplSession.getOrCreate(uniqueThreadId());
      expect((await session.eval("typeof process", TIMEOUT)).value).toBe(
        "undefined",
      );
    });

    it("should not expose require", async () => {
      session = ReplSession.getOrCreate(uniqueThreadId());
      expect((await session.eval("typeof require", TIMEOUT)).value).toBe(
        "undefined",
      );
    });

    it("should not expose fetch", async () => {
      session = ReplSession.getOrCreate(uniqueThreadId());
      expect((await session.eval("typeof fetch", TIMEOUT)).value).toBe(
        "undefined",
      );
    });

    it("should have standard built-ins", async () => {
      session = ReplSession.getOrCreate(uniqueThreadId());
      expect((await session.eval("JSON.stringify({a:1})", TIMEOUT)).value).toBe(
        '{"a":1}',
      );
      expect((await session.eval("Math.max(1,2,3)", TIMEOUT)).value).toBe(3);
    });
  });

  describe("backend VFS", () => {
    it("should read files from the backend", async () => {
      session = ReplSession.getOrCreate(uniqueThreadId(), {
        backend: createMockBackend({ "/data.json": '{"n": 42}' }),
      });

      const result = await session.eval(
        'const raw = await readFile("/data.json"); JSON.parse(raw).n',
        TIMEOUT,
      );
      expect(result.value).toBe(42);
    });

    it("should error on missing files", async () => {
      session = ReplSession.getOrCreate(uniqueThreadId(), {
        backend: createMockBackend(),
      });

      const result = await session.eval(
        'var msg; try { await readFile("/missing") } catch(e) { msg = e.message }\nmsg',
        TIMEOUT,
      );
      expect(result.ok).toBe(true);
      expect(result.value).toContain("ENOENT");
    });

    it("should buffer writes and flush to the backend", async () => {
      const backend = createMockBackend();
      session = ReplSession.getOrCreate(uniqueThreadId(), { backend });

      await session.eval('await writeFile("/out.txt", "hello")', TIMEOUT);
      expect(backend.written["/out.txt"]).toBeUndefined();
      expect(session.pendingWrites).toHaveLength(1);
      await session.flushWrites(backend);
      expect(backend.written["/out.txt"]).toBe("hello");
      expect(session.pendingWrites).toHaveLength(0);
    });

    it("should read back written files after flush", async () => {
      const backend = createMockBackend();
      session = ReplSession.getOrCreate(uniqueThreadId(), { backend });

      await session.eval('await writeFile("/f.txt", "content")', TIMEOUT);
      await session.flushWrites(backend);
      const result = await session.eval('await readFile("/f.txt")', TIMEOUT);
      expect(result.value).toBe("content");
    });
  });

  describe("PTC (programmatic tool calling)", () => {
    it("should call tools with await", async () => {
      const addTool = tool(async (input) => String(input.a + input.b), {
        name: "add",
        description: "Add two numbers",
        schema: z.object({ a: z.number(), b: z.number() }),
      });

      session = ReplSession.getOrCreate(uniqueThreadId(), {
        backend: createMockBackend(),
        tools: [addTool],
      });

      const result = await session.eval(
        "await tools.add({ a: 3, b: 4 })",
        TIMEOUT,
      );
      expect(result.ok).toBe(true);
      expect(result.value).toBe("7");
    });

    it("should auto-resolve promises without explicit await", async () => {
      const addTool = tool(async (input) => String(input.a + input.b), {
        name: "add",
        description: "Add two numbers",
        schema: z.object({ a: z.number(), b: z.number() }),
      });

      session = ReplSession.getOrCreate(uniqueThreadId(), {
        backend: createMockBackend(),
        tools: [addTool],
      });

      const result = await session.eval("tools.add({ a: 10, b: 5 })", TIMEOUT);
      expect(result.ok).toBe(true);
      expect(result.value).toBe("15");
    });

    it("should inject multiple tools", async () => {
      const upperTool = tool(async (input) => input.text.toUpperCase(), {
        name: "upper",
        description: "Uppercase a string",
        schema: z.object({ text: z.string() }),
      });
      const lowerTool = tool(async (input) => input.text.toLowerCase(), {
        name: "lower",
        description: "Lowercase a string",
        schema: z.object({ text: z.string() }),
      });

      session = ReplSession.getOrCreate(uniqueThreadId(), {
        backend: createMockBackend(),
        tools: [upperTool, lowerTool],
      });

      const r1 = await session.eval(
        'await tools.upper({ text: "hello" })',
        TIMEOUT,
      );
      expect(r1.value).toBe("HELLO");

      const r2 = await session.eval(
        'await tools.lower({ text: "WORLD" })',
        TIMEOUT,
      );
      expect(r2.value).toBe("world");
    });

    it("should camelCase snake_case tool names", async () => {
      const webSearchTool = tool(
        async (input) => `results for ${input.query}`,
        {
          name: "web_search",
          description: "Search the web",
          schema: z.object({ query: z.string() }),
        },
      );

      session = ReplSession.getOrCreate(uniqueThreadId(), {
        backend: createMockBackend(),
        tools: [webSearchTool],
      });

      const result = await session.eval(
        'await tools.webSearch({ query: "test" })',
        TIMEOUT,
      );
      expect(result.ok).toBe(true);
      expect(result.value).toBe("results for test");
    });

    it("should support Promise.all for concurrent tool calls", async () => {
      const echoTool = tool(async (input) => `echo-${input.id}`, {
        name: "echo",
        description: "Echo back an id",
        schema: z.object({ id: z.number() }),
      });

      session = ReplSession.getOrCreate(uniqueThreadId(), {
        backend: createMockBackend(),
        tools: [echoTool],
      });

      const result = await session.eval(
        `const results = await Promise.all([
          tools.echo({ id: 1 }),
          tools.echo({ id: 2 }),
          tools.echo({ id: 3 }),
        ]);
        results`,
        TIMEOUT,
      );
      expect(result.ok).toBe(true);
      expect(result.value).toEqual(["echo-1", "echo-2", "echo-3"]);
    });

    it("should handle tool errors gracefully", async () => {
      const failingTool = tool(
        async (): Promise<string> => {
          throw new Error("tool broke");
        },
        {
          name: "failing",
          description: "Always fails",
          schema: z.object({}),
        },
      );

      session = ReplSession.getOrCreate(uniqueThreadId(), {
        backend: createMockBackend(),
        tools: [failingTool],
      });

      const result = await session.eval(
        "var msg; try { await tools.failing({}) } catch(e) { msg = e.message }\nmsg",
        TIMEOUT,
      );
      expect(result.ok).toBe(true);
      expect(result.value).toContain("tool broke");
    });
  });

  describe("session dedup", () => {
    it("should share runtime state for the same id", async () => {
      const id = uniqueThreadId();
      const s1 = ReplSession.getOrCreate(id);
      await s1.eval("var shared = 42", TIMEOUT);
      const s2 = ReplSession.getOrCreate(id);
      expect(s1).toBe(s2);
      const result = await s2.eval("shared", TIMEOUT);
      expect(result.value).toBe(42);
      session = s1;
    });

    it("should not create multiple sessions for the same thread", async () => {
      const id = uniqueThreadId();
      const s1 = ReplSession.getOrCreate(id);
      const s2 = ReplSession.getOrCreate(id);
      const s3 = ReplSession.getOrCreate(id);
      expect(s1).toBe(s2);
      expect(s2).toBe(s3);
      expect(ReplSession.get(id)).toBe(s1);
      session = s1;
    });

    it("should isolate runtime state for different ids", async () => {
      const s1 = ReplSession.getOrCreate(uniqueThreadId());
      const s2 = ReplSession.getOrCreate(uniqueThreadId());
      await s1.eval("var x = 1", TIMEOUT);
      const result = await s2.eval("typeof x", TIMEOUT);
      expect(result.value).toBe("undefined");
      s1.dispose();
      session = s2;
    });
  });

  describe("serialization", () => {
    it("should serialize to JSON and restore", async () => {
      const id = uniqueThreadId();
      session = ReplSession.getOrCreate(id);
      await session.eval("var x = 99", TIMEOUT);

      const json = session.toJSON();
      expect(json).toEqual({ id });

      const restored = ReplSession.fromJSON(json);
      expect(restored).toBe(session);
      const result = await restored.eval("x", TIMEOUT);
      expect(result.value).toBe(99);
    });

    it("should survive round-trip through JSON.stringify/parse", async () => {
      const id = uniqueThreadId();
      session = ReplSession.getOrCreate(id);
      await session.eval("var msg = 'hello'", TIMEOUT);

      const serialized = JSON.stringify(session);
      const restored = ReplSession.fromJSON(JSON.parse(serialized));
      const result = await restored.eval("msg", TIMEOUT);
      expect(result.value).toBe("hello");
    });
  });
});
