import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tool } from "langchain";
import { z } from "zod/v4";
import type {
  AnyBackendProtocol,
  FileDownloadResponse,
  SkillMetadata,
} from "deepagents";
import { ReplSession } from "./session.js";
import type { SkillsContext } from "./types.js";

const TIMEOUT = 5000;
let nextId = 0;

function uniqueThreadId() {
  return `test-${++nextId}-${Date.now()}`;
}

function createInMemoryFileTools() {
  const store = new Map<string, string>();
  const readTool = tool(
    async (input: { path: string }) => {
      const content = store.get(input.path);
      if (content === undefined) {
        throw new Error(`ENOENT: no such file or directory '${input.path}'`);
      }
      return content;
    },
    {
      name: "read_file",
      description: "Read a file",
      schema: z.object({ path: z.string() }),
    },
  );
  const writeTool = tool(
    async (input: { path: string; content: string }) => {
      store.set(input.path, input.content);
      return "ok";
    },
    {
      name: "write_file",
      description: "Write a file",
      schema: z.object({ path: z.string(), content: z.string() }),
    },
  );
  return { readTool, writeTool, store };
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

    it("should reference prior cell data by variable name instead of re-embedding", async () => {
      session = ReplSession.getOrCreate(uniqueThreadId());

      // Cell 1: store a dataset (mimics Promise.all result)
      await session.eval(
        `const cities = [
          { city: "Tokyo", population: 13960000, area_sq_km: 2194 },
          { city: "Seoul", population: 9776000, area_sq_km: 605 },
          { city: "London", population: 8982000, area_sq_km: 1572 }
        ]`,
        TIMEOUT,
      );

      // Cell 2: reference `cities` by name — not re-embedded as a literal
      const result = await session.eval(
        "const densities = cities.map(c => ({ city: c.city, density: Math.round(c.population / c.area_sq_km) }))\ndensities",
        TIMEOUT,
      );

      expect(result.ok).toBe(true);
      expect(result.value).toEqual([
        { city: "Tokyo", density: Math.round(13960000 / 2194) },
        { city: "Seoul", density: Math.round(9776000 / 605) },
        { city: "London", density: Math.round(8982000 / 1572) },
      ]);
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

  describe("semicolons in expressions", () => {
    it("should execute code with trailing semicolons on the last expression", async () => {
      session = ReplSession.getOrCreate(uniqueThreadId());
      const result = await session.eval("const x = 42;\nx;", TIMEOUT);
      expect(result.ok).toBe(true);
      expect(result.value).toBe(42);
    });

    it("should handle console.log with trailing semicolon", async () => {
      session = ReplSession.getOrCreate(uniqueThreadId());
      const result = await session.eval('console.log("hi");', TIMEOUT);
      expect(result.ok).toBe(true);
      expect(result.logs).toEqual(["hi"]);
    });

    it("should handle multi-statement code where all lines have semicolons", async () => {
      session = ReplSession.getOrCreate(uniqueThreadId());
      const result = await session.eval(
        "const a = 1;\nconst b = 2;\na + b;",
        TIMEOUT,
      );
      expect(result.ok).toBe(true);
      expect(result.value).toBe(3);
    });
  });

  describe("TypeScript in initializers", () => {
    it("should execute 'as' expressions in variable initializers", async () => {
      session = ReplSession.getOrCreate(uniqueThreadId());
      const result = await session.eval(
        "const data = JSON.parse('{\"n\":42}') as { n: number }\ndata.n",
        TIMEOUT,
      );
      expect(result.ok).toBe(true);
      expect(result.value).toBe(42);
    });

    it("should execute typed arrow functions in initializers", async () => {
      session = ReplSession.getOrCreate(uniqueThreadId());
      const result = await session.eval(
        "const fn = (x: number): number => x * 2\nfn(21)",
        TIMEOUT,
      );
      expect(result.ok).toBe(true);
      expect(result.value).toBe(42);
    });

    it("should execute non-null assertions in initializers", async () => {
      session = ReplSession.getOrCreate(uniqueThreadId());
      const result = await session.eval(
        "const obj = { a: 1 } as { a: number } | null\nconst val = obj!\nval.a",
        TIMEOUT,
      );
      expect(result.ok).toBe(true);
      expect(result.value).toBe(1);
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

  describe("console buffer", () => {
    it("caps output at maxResultChars and reports dropped chars", async () => {
      session = ReplSession.getOrCreate(uniqueThreadId(), {
        maxResultChars: 10,
      });
      const result = await session.eval(
        'console.log("hello world this is too long")',
        TIMEOUT,
      );
      expect(result.logsDroppedChars).toBeGreaterThan(0);
      expect(result.logs.join("\n").length).toBeLessThanOrEqual(10);
    });

    it("preserves early output when overflow occurs", async () => {
      session = ReplSession.getOrCreate(uniqueThreadId(), {
        maxResultChars: 5,
      });
      const result = await session.eval('console.log("abcdefghij")', TIMEOUT);
      expect(result.logs.join("")).toMatch(/^abcde/);
      expect(result.logsDroppedChars).toBeGreaterThan(0);
    });

    it("resets truncation state between evaluations", async () => {
      session = ReplSession.getOrCreate(uniqueThreadId(), {
        maxResultChars: 10,
      });
      await session.eval(
        'console.log("overflow: this is way too long")',
        TIMEOUT,
      );
      const result = await session.eval('console.log("hi")', TIMEOUT);
      expect(result.logsDroppedChars).toBe(0);
      expect(result.logs.join("")).toContain("hi");
    });

    it("drops everything with a zero-char budget", async () => {
      session = ReplSession.getOrCreate(uniqueThreadId(), {
        maxResultChars: 0,
      });
      const result = await session.eval('console.log("anything")', TIMEOUT);
      expect(result.logs).toHaveLength(0);
      expect(result.logsDroppedChars).toBeGreaterThan(0);
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

  describe("sandbox globals", () => {
    it("should not expose readFile as a global", async () => {
      session = ReplSession.getOrCreate(uniqueThreadId());
      const result = await session.eval("typeof readFile", TIMEOUT);
      expect(result.ok).toBe(true);
      expect(result.value).toBe("undefined");
    });

    it("should not expose writeFile as a global", async () => {
      session = ReplSession.getOrCreate(uniqueThreadId());
      const result = await session.eval("typeof writeFile", TIMEOUT);
      expect(result.ok).toBe(true);
      expect(result.value).toBe("undefined");
    });
  });

  describe("PTC file tools", () => {
    it("should read files via PTC tool", async () => {
      const { readTool, writeTool, store } = createInMemoryFileTools();
      store.set("/data.json", '{"n":42}');
      session = ReplSession.getOrCreate(uniqueThreadId(), {
        tools: [readTool, writeTool],
      });

      const result = await session.eval(
        'const raw = await tools.readFile({ path: "/data.json" }); JSON.parse(raw).n',
        TIMEOUT,
      );
      expect(result.ok).toBe(true);
      expect(result.value).toBe(42);
    });

    it("should error on missing files via PTC tool", async () => {
      const { readTool, writeTool } = createInMemoryFileTools();
      session = ReplSession.getOrCreate(uniqueThreadId(), {
        tools: [readTool, writeTool],
      });

      const result = await session.eval(
        'var msg; try { await tools.readFile({ path: "/missing" }) } catch(e) { msg = e.message }\nmsg',
        TIMEOUT,
      );
      expect(result.ok).toBe(true);
      expect(result.value).toContain("ENOENT");
    });

    it("should write and read back in the same eval", async () => {
      const { readTool, writeTool } = createInMemoryFileTools();
      session = ReplSession.getOrCreate(uniqueThreadId(), {
        tools: [readTool, writeTool],
      });

      const result = await session.eval(
        `await tools.writeFile({ path: "/f.txt", content: "hello" });
         await tools.readFile({ path: "/f.txt" })`,
        TIMEOUT,
      );
      expect(result.ok).toBe(true);
      expect(result.value).toBe("hello");
    });

    it("should write in one eval and read in the next", async () => {
      const { readTool, writeTool } = createInMemoryFileTools();
      session = ReplSession.getOrCreate(uniqueThreadId(), {
        tools: [readTool, writeTool],
      });

      await session.eval(
        'await tools.writeFile({ path: "/out.txt", content: "persisted" })',
        TIMEOUT,
      );
      const result = await session.eval(
        'await tools.readFile({ path: "/out.txt" })',
        TIMEOUT,
      );
      expect(result.ok).toBe(true);
      expect(result.value).toBe("persisted");
    });
  });

  describe("PTC call budget", () => {
    const greetTool = tool(
      async (input: { name: string }) => `hello ${input.name}`,
      {
        name: "greet",
        description: "Greet someone",
        schema: z.object({ name: z.string() }),
      },
    );

    it("should reject on the call that exceeds the budget", async () => {
      session = ReplSession.getOrCreate(uniqueThreadId(), {
        tools: [greetTool],
        maxPtcCalls: 1,
      });

      const result = await session.eval(
        `await tools.greet({ name: "a" });
         await tools.greet({ name: "b" });`,
        TIMEOUT,
      );

      expect(result.ok).toBe(false);
      expect(result.error?.message).toContain("PTC call budget");
    });

    it("should succeed when calls stay within the budget", async () => {
      session = ReplSession.getOrCreate(uniqueThreadId(), {
        tools: [greetTool],
        maxPtcCalls: 2,
      });

      const result = await session.eval(
        `const a = await tools.greet({ name: "a" });
         const b = await tools.greet({ name: "b" });
         a + " " + b`,
        TIMEOUT,
      );

      expect(result.ok).toBe(true);
      expect(result.value).toBe("hello a hello b");
    });

    it("should reset the budget between evals", async () => {
      session = ReplSession.getOrCreate(uniqueThreadId(), {
        tools: [greetTool],
        maxPtcCalls: 1,
      });

      const first = await session.eval(
        `await tools.greet({ name: "a" })`,
        TIMEOUT,
      );
      const second = await session.eval(
        `await tools.greet({ name: "b" })`,
        TIMEOUT,
      );

      expect(first.ok).toBe(true);
      expect(second.ok).toBe(true);
    });

    it("should allow unlimited calls when maxPtcCalls is null", async () => {
      session = ReplSession.getOrCreate(uniqueThreadId(), {
        tools: [greetTool],
        maxPtcCalls: null,
      });

      // Build a string that makes more calls than DEFAULT_MAX_PTC_CALLS
      const calls = Array.from(
        { length: 300 },
        (_, i) => `await tools.greet({ name: "${i}" })`,
      ).join(";\n");

      const result = await session.eval(calls, TIMEOUT * 6);

      expect(result.ok).toBe(true);
    });

    it("should surface budget message via JS try/catch", async () => {
      session = ReplSession.getOrCreate(uniqueThreadId(), {
        tools: [greetTool],
        maxPtcCalls: 1,
      });

      const result = await session.eval(
        `var msg;
         await tools.greet({ name: "a" });
         try { await tools.greet({ name: "b" }) } catch (e) { msg = e.message }
         msg`,
        TIMEOUT,
      );

      expect(result.ok).toBe(true);
      expect(result.value).toContain("PTC call budget");
    });

    it("should reject Promise.all when any call exceeds the budget", async () => {
      session = ReplSession.getOrCreate(uniqueThreadId(), {
        tools: [greetTool],
        maxPtcCalls: 1,
      });

      const result = await session.eval(
        `await Promise.all([
           tools.greet({ name: "a" }),
           tools.greet({ name: "b" }),
         ])`,
        TIMEOUT,
      );

      expect(result.ok).toBe(false);
      expect(result.error?.message).toContain("PTC call budget");
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

  describe("session deletion", () => {
    it("should dispose and remove an existing session", () => {
      const session = ReplSession.getOrCreate("test-key");
      expect(ReplSession.get("test-key")).toBe(session);
      ReplSession.deleteSession("test-key");
      expect(ReplSession.get("test-key")).toBeNull();
    });

    it("should no-op for a key that does not exist", () => {
      expect(() => ReplSession.deleteSession("nonexistent")).not.toThrow();
    });
  });
});

// ---------------------------------------------------------------------------
// Skills module loader
// ---------------------------------------------------------------------------

const enc = new TextEncoder();

function makeSkillsBackend(files: Record<string, string>): AnyBackendProtocol {
  return {
    glob: async (pattern: string, basePath?: string) => {
      const ext = pattern.replace("**/*", "");
      const matches = Object.keys(files)
        .filter((p) => p.startsWith(basePath ?? "") && p.endsWith(ext))
        .map((p) => ({ path: p }));
      return { files: matches };
    },
    downloadFiles: async (paths: string[]) => {
      return paths.map((p): FileDownloadResponse => {
        const content = files[p];
        if (content === undefined) {
          return { path: p, content: null, error: "file_not_found" };
        }
        return { path: p, content: enc.encode(content), error: null };
      });
    },
  } as unknown as AnyBackendProtocol;
}

function makeSkillsMeta(
  name: string,
  module: string,
  skillDir?: string,
): SkillMetadata {
  const dir = skillDir ?? `/skills/${name}`;
  return {
    name,
    description: `Test skill ${name}`,
    path: `${dir}/SKILL.md`,
    module,
  };
}

function makeSkillsContext(
  metadata: SkillMetadata[],
  files: Record<string, string>,
): SkillsContext {
  return { metadata, backend: makeSkillsBackend(files) };
}

describe("skills module loader", () => {
  let session: ReplSession;

  beforeEach(() => {
    ReplSession.clearCache();
  });

  afterEach(() => {
    if (session) session.dispose();
  });

  it("resolves a single-file skill and exposes its exports", async () => {
    session = ReplSession.getOrCreate(uniqueThreadId(), {
      skillsEnabled: true,
    });
    session.setSkillsContext(
      makeSkillsContext([makeSkillsMeta("my-skill", "index.js")], {
        "/skills/my-skill/index.js": "export const VALUE = 42;",
      }),
    );

    const result = await session.eval(
      `const mod = await import("@/skills/my-skill"); mod.VALUE`,
      TIMEOUT,
    );
    expect(result.ok).toBe(true);
    expect(result.value).toBe(42);
  });

  it("resolves relative imports inside a multi-file skill", async () => {
    session = ReplSession.getOrCreate(uniqueThreadId(), {
      skillsEnabled: true,
    });
    session.setSkillsContext(
      makeSkillsContext([makeSkillsMeta("my-skill", "index.js")], {
        "/skills/my-skill/index.js":
          "import { add } from './lib/math.js'; export function compute() { return add(1, 2); }",
        "/skills/my-skill/lib/math.js":
          "export function add(a, b) { return a + b; }",
      }),
    );

    const result = await session.eval(
      `const { compute } = await import("@/skills/my-skill"); compute()`,
      TIMEOUT,
    );
    expect(result.ok).toBe(true);
    expect(result.value).toBe(3);
  });

  it("rejects import of an unknown skill with a recognizable message", async () => {
    session = ReplSession.getOrCreate(uniqueThreadId(), {
      skillsEnabled: true,
    });
    session.setSkillsContext(makeSkillsContext([], {}));

    const result = await session.eval(
      `await import("@/skills/unknown")`,
      TIMEOUT,
    );
    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain("not available on this agent");
  });

  it("rejects import when skills context is cleared", async () => {
    session = ReplSession.getOrCreate(uniqueThreadId(), {
      skillsEnabled: true,
    });
    session.setSkillsContext(undefined);

    const result = await session.eval(
      `await import("@/skills/my-skill")`,
      TIMEOUT,
    );
    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain("not configured");
  });

  it("rejects traversal escape from inside a skill", async () => {
    session = ReplSession.getOrCreate(uniqueThreadId(), {
      skillsEnabled: true,
    });
    session.setSkillsContext(
      makeSkillsContext([makeSkillsMeta("my-skill", "index.js")], {
        "/skills/my-skill/index.js":
          "export { escape } from '../../other-skill/index.js';",
      }),
    );

    const result = await session.eval(
      `await import("@/skills/my-skill")`,
      TIMEOUT,
    );
    expect(result.ok).toBe(false);
  });

  it("caches a load failure and does not re-fetch from the backend", async () => {
    let downloadCount = 0;
    const meta = makeSkillsMeta("my-skill", "index.js");
    const backend = {
      glob: async (pattern: string) => {
        const ext = pattern.replace("**/*", "");
        if (ext === ".js") {
          return { files: [{ path: "/skills/my-skill/index.js" }] };
        }
        return { files: [] };
      },
      downloadFiles: async (paths: string[]) => {
        downloadCount++;
        return paths.map(
          (p): FileDownloadResponse => ({
            path: p,
            content: null,
            error: "file_not_found",
          }),
        );
      },
    } as unknown as AnyBackendProtocol;

    session = ReplSession.getOrCreate(uniqueThreadId(), {
      skillsEnabled: true,
    });
    session.setSkillsContext({ metadata: [meta], backend });

    await session.eval(
      `await import("@/skills/my-skill").catch(() => null)`,
      TIMEOUT,
    );
    await session.eval(
      `await import("@/skills/my-skill").catch(() => null)`,
      TIMEOUT,
    );

    expect(downloadCount).toBe(1);
  });
});
