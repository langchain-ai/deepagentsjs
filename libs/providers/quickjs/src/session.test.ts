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
      session = await ReplSession.getOrCreate(uniqueThreadId());
      const result = await session.eval("1 + 2", TIMEOUT);
      expect(result.ok).toBe(true);
      expect(result.value).toBe(3);
    });

    it("should return strings", async () => {
      session = await ReplSession.getOrCreate(uniqueThreadId());
      const result = await session.eval('"hello"', TIMEOUT);
      expect(result.ok).toBe(true);
      expect(result.value).toBe("hello");
    });

    it("should return objects", async () => {
      session = await ReplSession.getOrCreate(uniqueThreadId());
      const result = await session.eval('({ a: 1, b: "two" })', TIMEOUT);
      expect(result.ok).toBe(true);
      expect(result.value).toEqual({ a: 1, b: "two" });
    });

    it("should return arrays", async () => {
      session = await ReplSession.getOrCreate(uniqueThreadId());
      const result = await session.eval("[1, 2, 3]", TIMEOUT);
      expect(result.ok).toBe(true);
      expect(result.value).toEqual([1, 2, 3]);
    });
  });

  describe("state persistence", () => {
    it("should persist variables across evaluations", async () => {
      session = await ReplSession.getOrCreate(uniqueThreadId());
      await session.eval("var counter = 0", TIMEOUT);
      await session.eval("counter++", TIMEOUT);
      await session.eval("counter++", TIMEOUT);
      const result = await session.eval("counter", TIMEOUT);
      expect(result.value).toBe(2);
    });

    it("should persist functions", async () => {
      session = await ReplSession.getOrCreate(uniqueThreadId());
      await session.eval("function double(x) { return x * 2; }", TIMEOUT);
      const result = await session.eval("double(21)", TIMEOUT);
      expect(result.value).toBe(42);
    });

    it("should persist closures", async () => {
      session = await ReplSession.getOrCreate(uniqueThreadId());
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
      session = await ReplSession.getOrCreate(uniqueThreadId());
      const result = await session.eval('console.log("hello"); 42', TIMEOUT);
      expect(result.logs).toEqual(["hello"]);
      expect(result.value).toBe(42);
    });

    it("should label console.warn and console.error", async () => {
      session = await ReplSession.getOrCreate(uniqueThreadId());
      const result = await session.eval(
        'console.warn("w"); console.error("e")',
        TIMEOUT,
      );
      expect(result.logs).toContain("[warn] w");
      expect(result.logs).toContain("[error] e");
    });

    it("should clear logs between evaluations", async () => {
      session = await ReplSession.getOrCreate(uniqueThreadId());
      await session.eval('console.log("first")', TIMEOUT);
      const result = await session.eval('console.log("second")', TIMEOUT);
      expect(result.logs).toEqual(["second"]);
    });
  });

  describe("error handling", () => {
    it("should report syntax errors", async () => {
      session = await ReplSession.getOrCreate(uniqueThreadId());
      const result = await session.eval("function(", TIMEOUT);
      expect(result.ok).toBe(false);
      expect(result.error).toBeDefined();
    });

    it("should report runtime errors", async () => {
      session = await ReplSession.getOrCreate(uniqueThreadId());
      const result = await session.eval("undefinedVar.prop", TIMEOUT);
      expect(result.ok).toBe(false);
    });

    it("should preserve state after errors", async () => {
      session = await ReplSession.getOrCreate(uniqueThreadId());
      await session.eval("var x = 42", TIMEOUT);
      await session.eval('throw new Error("oops")', TIMEOUT);
      const result = await session.eval("x", TIMEOUT);
      expect(result.value).toBe(42);
    });
  });

  describe("execution limits", () => {
    it("should timeout on infinite loops", async () => {
      session = await ReplSession.getOrCreate(uniqueThreadId());
      const result = await session.eval("while(true) {}", 200);
      expect(result.ok).toBe(false);
      expect(result.error?.message).toContain("interrupted");
    });
  });

  describe("sandbox isolation", () => {
    it("should not expose process", async () => {
      session = await ReplSession.getOrCreate(uniqueThreadId());
      expect((await session.eval("typeof process", TIMEOUT)).value).toBe(
        "undefined",
      );
    });

    it("should not expose require", async () => {
      session = await ReplSession.getOrCreate(uniqueThreadId());
      expect((await session.eval("typeof require", TIMEOUT)).value).toBe(
        "undefined",
      );
    });

    it("should not expose fetch", async () => {
      session = await ReplSession.getOrCreate(uniqueThreadId());
      expect((await session.eval("typeof fetch", TIMEOUT)).value).toBe(
        "undefined",
      );
    });

    it("should have standard built-ins", async () => {
      session = await ReplSession.getOrCreate(uniqueThreadId());
      expect(
        (await session.eval("JSON.stringify({a:1})", TIMEOUT)).value,
      ).toBe('{"a":1}');
      expect((await session.eval("Math.max(1,2,3)", TIMEOUT)).value).toBe(3);
    });
  });

  describe("backend VFS", () => {
    it("should read files from the backend", async () => {
      session = await ReplSession.getOrCreate(uniqueThreadId(), {
        backend: createMockBackend({ "/data.json": '{"n": 42}' }),
      });

      const result = await session.eval(
        'const raw = await readFile("/data.json"); JSON.parse(raw).n',
        TIMEOUT,
      );
      expect(result.value).toBe(42);
    });

    it("should error on missing files", async () => {
      session = await ReplSession.getOrCreate(uniqueThreadId(), {
        backend: createMockBackend(),
      });

      const result = await session.eval(
        'var msg; try { await readFile("/missing") } catch(e) { msg = e.message }\nmsg',
        TIMEOUT,
      );
      expect(result.ok).toBe(true);
      expect(result.value).toContain("ENOENT");
    });

    it("should write files to the backend", async () => {
      const backend = createMockBackend();
      session = await ReplSession.getOrCreate(uniqueThreadId(), { backend });

      await session.eval('await writeFile("/out.txt", "hello")', TIMEOUT);
      expect(backend.written["/out.txt"]).toBe("hello");
    });

    it("should read back written files", async () => {
      session = await ReplSession.getOrCreate(uniqueThreadId(), {
        backend: createMockBackend(),
      });

      await session.eval('await writeFile("/f.txt", "content")', TIMEOUT);
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

      session = await ReplSession.getOrCreate(uniqueThreadId(), {
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

      session = await ReplSession.getOrCreate(uniqueThreadId(), {
        backend: createMockBackend(),
        tools: [addTool],
      });

      const result = await session.eval(
        "tools.add({ a: 10, b: 5 })",
        TIMEOUT,
      );
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

      session = await ReplSession.getOrCreate(uniqueThreadId(), {
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

      session = await ReplSession.getOrCreate(uniqueThreadId(), {
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

      session = await ReplSession.getOrCreate(uniqueThreadId(), {
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

      session = await ReplSession.getOrCreate(uniqueThreadId(), {
        backend: createMockBackend(),
        tools: [failingTool],
      });

      const result = await session.eval(
        'var msg; try { await tools.failing({}) } catch(e) { msg = e.message }\nmsg',
        TIMEOUT,
      );
      expect(result.ok).toBe(true);
      expect(result.value).toContain("tool broke");
    });
  });

  describe("session dedup", () => {
    it("should return the same session for the same threadId", async () => {
      const id = uniqueThreadId();
      const s1 = await ReplSession.getOrCreate(id);
      const s2 = await ReplSession.getOrCreate(id);
      expect(s1).toBe(s2);
      session = s1;
    });

    it("should return different sessions for different threadIds", async () => {
      const s1 = await ReplSession.getOrCreate(uniqueThreadId());
      const s2 = await ReplSession.getOrCreate(uniqueThreadId());
      expect(s1).not.toBe(s2);
      s1.dispose();
      session = s2;
    });
  });

  describe("environment variables", () => {
    it("should not expose process global when env is set", async () => {
      session = await ReplSession.getOrCreate(uniqueThreadId(), {
        env: { NODE_ENV: "production" },
      });

      const result = await session.eval("typeof process", TIMEOUT);
      expect(result.value).toBe("undefined");
    });

    it("should expose plain env vars via env global", async () => {
      session = await ReplSession.getOrCreate(uniqueThreadId(), {
        env: { NODE_ENV: "production", APP_NAME: "test" },
      });

      const r1 = await session.eval("env.NODE_ENV", TIMEOUT);
      expect(r1.value).toBe("production");

      const r2 = await session.eval("env.APP_NAME", TIMEOUT);
      expect(r2.value).toBe("test");
    });

    it("should expose secret env vars as opaque refs", async () => {
      session = await ReplSession.getOrCreate(uniqueThreadId(), {
        env: {
          API_KEY: { value: "sk-real-key", secret: true, allowedTools: ["http"] },
        },
      });

      const result = await session.eval("env.API_KEY", TIMEOUT);
      expect(result.ok).toBe(true);
      expect(result.value).toContain("__secret__");
      expect(result.value).not.toContain("sk-real-key");
    });

    it("should rewrite secret refs for allowed tools", async () => {
      const echoTool = tool(async (input) => `got: ${input.key}`, {
        name: "echo",
        description: "Echo",
        schema: z.object({ key: z.string() }),
      });

      session = await ReplSession.getOrCreate(uniqueThreadId(), {
        backend: createMockBackend(),
        tools: [echoTool],
        env: {
          API_KEY: { value: "sk-real-key", secret: true, allowedTools: ["echo"] },
        },
      });

      const result = await session.eval(
        "await tools.echo({ key: env.API_KEY })",
        TIMEOUT,
      );
      expect(result.ok).toBe(true);
      expect(result.value).toBe("got: sk-real-key");
    });

    it("should reject secret refs for disallowed tools", async () => {
      const echoTool = tool(async (input) => `got: ${input.key}`, {
        name: "echo",
        description: "Echo",
        schema: z.object({ key: z.string() }),
      });

      session = await ReplSession.getOrCreate(uniqueThreadId(), {
        backend: createMockBackend(),
        tools: [echoTool],
        env: {
          API_KEY: { value: "sk-real-key", secret: true, allowedTools: ["other_tool"] },
        },
      });

      const result = await session.eval(
        'var msg; try { await tools.echo({ key: env.API_KEY }) } catch(e) { msg = e.message }\nmsg',
        TIMEOUT,
      );
      expect(result.ok).toBe(true);
      expect(result.value).toContain("Env access denied");
      expect(result.value).toContain("echo");
    });

    it("should mix plain and secret env vars", async () => {
      const echoTool = tool(async (input) => JSON.stringify(input), {
        name: "echo",
        description: "Echo",
        schema: z.object({ a: z.string(), b: z.string() }),
      });

      session = await ReplSession.getOrCreate(uniqueThreadId(), {
        backend: createMockBackend(),
        tools: [echoTool],
        env: {
          PLAIN: "visible",
          SECRET: { value: "hidden", secret: true, allowedTools: ["echo"] },
        },
      });

      const result = await session.eval(
        "await tools.echo({ a: env.PLAIN, b: env.SECRET })",
        TIMEOUT,
      );
      expect(result.ok).toBe(true);
      const parsed = JSON.parse(result.value as string);
      expect(parsed.a).toBe("visible");
      expect(parsed.b).toBe("hidden");
    });

    it("should allow restricted plain env var for allowed tool", async () => {
      const echoTool = tool(async (input) => `got: ${input.host}`, {
        name: "db_query",
        description: "DB query",
        schema: z.object({ host: z.string() }),
      });

      session = await ReplSession.getOrCreate(uniqueThreadId(), {
        backend: createMockBackend(),
        tools: [echoTool],
        env: {
          DB_HOST: { value: "10.0.0.1", allowedTools: ["db_query"] },
        },
      });

      const result = await session.eval(
        "await tools.dbQuery({ host: env.DB_HOST })",
        TIMEOUT,
      );
      expect(result.ok).toBe(true);
      expect(result.value).toBe("got: 10.0.0.1");
    });

    it("should reject restricted plain env var for disallowed tool", async () => {
      const echoTool = tool(async (input) => `got: ${input.host}`, {
        name: "echo",
        description: "Echo",
        schema: z.object({ host: z.string() }),
      });

      session = await ReplSession.getOrCreate(uniqueThreadId(), {
        backend: createMockBackend(),
        tools: [echoTool],
        env: {
          DB_HOST: { value: "10.0.0.1", allowedTools: ["db_query"] },
        },
      });

      const result = await session.eval(
        'var msg; try { await tools.echo({ host: env.DB_HOST }) } catch(e) { msg = e.message }\nmsg',
        TIMEOUT,
      );
      expect(result.ok).toBe(true);
      expect(result.value).toContain("Env access denied");
      expect(result.value).toContain("echo");
    });

    it("should expose restricted plain env var value in REPL", async () => {
      session = await ReplSession.getOrCreate(uniqueThreadId(), {
        env: {
          DB_HOST: { value: "10.0.0.1", allowedTools: ["db_query"] },
        },
      });

      const result = await session.eval("env.DB_HOST", TIMEOUT);
      expect(result.ok).toBe(true);
      expect(result.value).toBe("10.0.0.1");
    });

    it("should allow secret without allowedTools in any tool", async () => {
      const echoTool = tool(async (input) => `got: ${input.key}`, {
        name: "echo",
        description: "Echo",
        schema: z.object({ key: z.string() }),
      });

      session = await ReplSession.getOrCreate(uniqueThreadId(), {
        backend: createMockBackend(),
        tools: [echoTool],
        env: {
          API_KEY: { value: "sk-real-key", secret: true },
        },
      });

      const visible = await session.eval("env.API_KEY", TIMEOUT);
      expect(visible.value).toContain("__secret__");
      expect(visible.value).not.toContain("sk-real-key");

      const result = await session.eval(
        "await tools.echo({ key: env.API_KEY })",
        TIMEOUT,
      );
      expect(result.ok).toBe(true);
      expect(result.value).toBe("got: sk-real-key");
    });

    it("should not block unrestricted plain env vars in any tool", async () => {
      const echoTool = tool(async (input) => `got: ${input.val}`, {
        name: "echo",
        description: "Echo",
        schema: z.object({ val: z.string() }),
      });

      session = await ReplSession.getOrCreate(uniqueThreadId(), {
        backend: createMockBackend(),
        tools: [echoTool],
        env: { PLAIN: "hello" },
      });

      const result = await session.eval(
        "await tools.echo({ val: env.PLAIN })",
        TIMEOUT,
      );
      expect(result.ok).toBe(true);
      expect(result.value).toBe("got: hello");
    });

    it("should block writing secret env values to files", async () => {
      session = await ReplSession.getOrCreate(uniqueThreadId(), {
        backend: createMockBackend(),
        env: {
          API_KEY: { value: "sk-real-key", secret: true, allowedTools: ["echo"] },
        },
      });

      const result = await session.eval(
        'var msg; try { await writeFile("/out.txt", env.API_KEY) } catch(e) { msg = e.message }\nmsg',
        TIMEOUT,
      );
      expect(result.ok).toBe(true);
      expect(result.value).toContain("Env access denied");
    });

    it("should block writing restricted plain env values to files", async () => {
      session = await ReplSession.getOrCreate(uniqueThreadId(), {
        backend: createMockBackend(),
        env: {
          DB_HOST: { value: "10.0.0.1", allowedTools: ["db_query"] },
        },
      });

      const result = await session.eval(
        'var msg; try { await writeFile("/out.txt", env.DB_HOST) } catch(e) { msg = e.message }\nmsg',
        TIMEOUT,
      );
      expect(result.ok).toBe(true);
      expect(result.value).toContain("Env access denied");
    });

    it("should allow writing unrestricted env values to files", async () => {
      const backend = createMockBackend();
      session = await ReplSession.getOrCreate(uniqueThreadId(), {
        backend,
        env: { PLAIN: "hello" },
      });

      const result = await session.eval(
        'await writeFile("/out.txt", env.PLAIN)',
        TIMEOUT,
      );
      expect(result.ok).toBe(true);
      expect(backend.written["/out.txt"]).toBe("hello");
    });
  });
});
