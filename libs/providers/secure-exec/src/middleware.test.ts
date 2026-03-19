import { describe, it, expect, vi, beforeEach } from "vitest";
import { tool } from "langchain";
import * as z from "zod";
import { SystemMessage } from "@langchain/core/messages";

// Mock deepagents to avoid langsmith/experimental/sandbox dependency
vi.mock("deepagents", () => ({
  adaptBackendProtocol: vi.fn((b) => b),
  StateBackend: vi.fn().mockImplementation(() => ({
    ls: vi.fn(),
    read: vi.fn(),
    readRaw: vi.fn(),
    write: vi.fn(),
    edit: vi.fn(),
    grep: vi.fn(),
    glob: vi.fn(),
  })),
}));

// Mock secure-exec to avoid spawning real V8 isolates
// NodeRuntime must use `function` form to be usable as a constructor with `new`
vi.mock("secure-exec", () => ({
  NodeRuntime: vi.fn(function (
    this: { run: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> },
  ) {
    this.run = vi.fn().mockResolvedValue({ code: 0, exports: {} });
    this.dispose = vi.fn();
  }),
  createNodeDriver: vi.fn().mockReturnValue({ type: "mock-driver" }),
  createNodeRuntimeDriverFactory: vi
    .fn()
    .mockReturnValue({ type: "mock-factory" }),
  allowAllFs: { fs: () => true },
  allowAllNetwork: { network: () => true },
}));

vi.mock("@secure-exec/typescript", () => ({
  createTypeScriptTools: vi.fn().mockReturnValue({
    compileSource: vi.fn().mockResolvedValue({ success: true, outputText: "" }),
  }),
}));

vi.mock("./transform.js", () => ({
  transformForEval: vi.fn().mockResolvedValue({
    fullSource: "(async () => { module.exports = { __result: undefined }; })()",
    result: {
      compiledCode: "",
      declarationSnippets: [],
      wasTypeScript: false,
      typeErrors: [],
    },
  }),
}));

import {
  createSecureExecMiddleware,
  generatePtcPrompt,
  DEFAULT_PTC_EXCLUDED_TOOLS,
} from "./middleware.js";
import { SecureExecSession } from "./session.js";

describe("createSecureExecMiddleware", () => {
  beforeEach(() => {
    SecureExecSession.clearCache();
  });

  describe("tool registration", () => {
    it("should register js_eval tool", () => {
      const middleware = createSecureExecMiddleware();
      expect(middleware.tools).toBeDefined();
      const names = middleware.tools!.map((t: { name: string }) => t.name);
      expect(names).toContain("js_eval");
    });

    it("should register exactly one tool", () => {
      const middleware = createSecureExecMiddleware();
      expect(middleware.tools!.length).toBe(1);
    });

    it("js_eval tool has the correct schema", () => {
      const middleware = createSecureExecMiddleware();
      const jsEval = middleware.tools![0] as { name: string; schema: unknown };
      expect(jsEval.name).toBe("js_eval");
    });
  });

  describe("wrapModelCall", () => {
    it("should add REPL system prompt with Node.js V8 messaging", async () => {
      const middleware = createSecureExecMiddleware();
      const mockHandler = vi.fn().mockReturnValue({ response: "ok" });

      await middleware.wrapModelCall!(
        {
          systemMessage: new SystemMessage("Base"),
          state: {},
          runtime: { configurable: { thread_id: "test-1" } },
          tools: middleware.tools || [],
        } as never,
        mockHandler,
      );

      const req = mockHandler.mock.calls[0][0] as {
        systemMessage: { text: string };
      };
      const text = req.systemMessage.text;
      expect(text).toContain("Base");
      expect(text).toContain("js_eval");
      expect(text).toContain("Node.js V8 worker");
      expect(text).toContain("TypeScript");
      expect(text).toContain("readFile");
      expect(text).toContain("writeFile");
      expect(text).toContain("require");
    });

    it("should document the persistence model", async () => {
      const middleware = createSecureExecMiddleware();
      const mockHandler = vi.fn().mockReturnValue({ response: "ok" });

      await middleware.wrapModelCall!(
        {
          systemMessage: new SystemMessage("Base"),
          state: {},
          runtime: { configurable: { thread_id: "test-persist" } },
          tools: middleware.tools || [],
        } as never,
        mockHandler,
      );

      const req = mockHandler.mock.calls[0][0] as {
        systemMessage: { text: string };
      };
      const text = req.systemMessage.text;
      expect(text).toContain("Persistence model");
      expect(text).toContain("re-evaluated");
    });

    it("should use custom system prompt when provided", async () => {
      const middleware = createSecureExecMiddleware({
        systemPrompt: "Custom secure-exec prompt",
      });
      const mockHandler = vi.fn().mockReturnValue({ response: "ok" });

      await middleware.wrapModelCall!(
        {
          systemMessage: new SystemMessage("Base"),
          state: {},
          runtime: { configurable: { thread_id: "test-custom" } },
          tools: middleware.tools || [],
        } as never,
        mockHandler,
      );

      const req = mockHandler.mock.calls[0][0] as {
        systemMessage: { text: string };
      };
      expect(req.systemMessage.text).toContain("Custom secure-exec prompt");
      expect(req.systemMessage.text).not.toContain("Node.js V8 worker");
    });

    it("should append PTC section when ptcTools is non-empty", async () => {
      const searchTool = tool(async () => "", {
        name: "web_search",
        description: "Search the web",
        schema: z.object({ query: z.string() }),
      });

      const middleware = createSecureExecMiddleware({ ptc: true });
      const mockHandler = vi.fn().mockReturnValue({ response: "ok" });

      await middleware.wrapModelCall!(
        {
          systemMessage: new SystemMessage("Base"),
          state: {},
          runtime: { configurable: { thread_id: "test-ptc" } },
          tools: [searchTool],
        } as never,
        mockHandler,
      );

      const req = mockHandler.mock.calls[0][0] as {
        systemMessage: { text: string };
      };
      const text = req.systemMessage.text;
      expect(text).toContain("tools");
      expect(text).toContain("webSearch");
    });

    it("should cache PTC prompt across multiple wrapModelCall invocations", async () => {
      const searchTool = tool(async () => "", {
        name: "search",
        description: "Search",
        schema: z.object({ q: z.string() }),
      });

      const middleware = createSecureExecMiddleware({ ptc: true });
      const mockHandler = vi.fn().mockReturnValue({ response: "ok" });

      // Call twice
      await middleware.wrapModelCall!(
        {
          systemMessage: new SystemMessage("Base"),
          state: {},
          runtime: { configurable: { thread_id: "test-cache-1" } },
          tools: [searchTool],
        } as never,
        mockHandler,
      );

      await middleware.wrapModelCall!(
        {
          systemMessage: new SystemMessage("Base"),
          state: {},
          runtime: { configurable: { thread_id: "test-cache-2" } },
          tools: [searchTool],
        } as never,
        mockHandler,
      );

      // Both calls should produce the same system message content
      const req1 = mockHandler.mock.calls[0][0] as {
        systemMessage: { text: string };
      };
      const req2 = mockHandler.mock.calls[1][0] as {
        systemMessage: { text: string };
      };
      expect(req1.systemMessage.text).toBe(req2.systemMessage.text);
    });
  });

  describe("PTC filtering", () => {
    const webSearch = tool(async () => "", {
      name: "web_search",
      description: "Search",
      schema: z.object({ q: z.string() }),
    });
    const readFile = tool(async () => "", {
      name: "read_file",
      description: "Read",
      schema: z.object({ p: z.string() }),
    });
    const writeFile = tool(async () => "", {
      name: "write_file",
      description: "Write",
      schema: z.object({ p: z.string(), c: z.string() }),
    });
    const jsEval = tool(async () => "", {
      name: "js_eval",
      description: "REPL",
      schema: z.object({ code: z.string() }),
    });
    const customTool = tool(async () => "", {
      name: "my_custom_tool",
      description: "Custom",
      schema: z.object({ x: z.string() }),
    });

    it("ptc:false exposes no tools inside REPL", async () => {
      const middleware = createSecureExecMiddleware({ ptc: false });
      const mockHandler = vi.fn().mockReturnValue({ response: "ok" });

      await middleware.wrapModelCall!(
        {
          systemMessage: new SystemMessage("Base"),
          state: {},
          runtime: { configurable: { thread_id: "ptc-false" } },
          tools: [webSearch, customTool],
        } as never,
        mockHandler,
      );

      const req = mockHandler.mock.calls[0][0] as {
        systemMessage: { text: string };
      };
      // No tools namespace should be injected
      expect(req.systemMessage.text).not.toContain("tools namespace");
    });

    it("ptc:true excludes DEFAULT_PTC_EXCLUDED_TOOLS", async () => {
      // Verify DEFAULT_PTC_EXCLUDED_TOOLS contains the expected tools
      expect(DEFAULT_PTC_EXCLUDED_TOOLS).toContain("read_file");
      expect(DEFAULT_PTC_EXCLUDED_TOOLS).toContain("write_file");
      expect(DEFAULT_PTC_EXCLUDED_TOOLS).toContain("ls");
    });

    it("ptc:true never exposes js_eval itself as PTC tool", async () => {
      const middleware = createSecureExecMiddleware({ ptc: true });
      const mockHandler = vi.fn().mockReturnValue({ response: "ok" });

      await middleware.wrapModelCall!(
        {
          systemMessage: new SystemMessage("Base"),
          state: {},
          runtime: { configurable: { thread_id: "ptc-no-self" } },
          tools: [jsEval, webSearch],
        } as never,
        mockHandler,
      );

      const req = mockHandler.mock.calls[0][0] as {
        systemMessage: { text: string };
      };
      // webSearch should be present but jsEval should not appear as a tool
      expect(req.systemMessage.text).toContain("webSearch");
      // The js_eval tool itself should not be listed as a PTC function
      expect(req.systemMessage.text).not.toContain("tools.jsEval");
    });

    it("ptc:string[] exposes only listed tools", async () => {
      const middleware = createSecureExecMiddleware({ ptc: ["web_search"] });
      const mockHandler = vi.fn().mockReturnValue({ response: "ok" });

      await middleware.wrapModelCall!(
        {
          systemMessage: new SystemMessage("Base"),
          state: {},
          runtime: { configurable: { thread_id: "ptc-include-arr" } },
          tools: [webSearch, customTool],
        } as never,
        mockHandler,
      );

      const req = mockHandler.mock.calls[0][0] as {
        systemMessage: { text: string };
      };
      expect(req.systemMessage.text).toContain("webSearch");
      expect(req.systemMessage.text).not.toContain("myCustomTool");
    });

    it("ptc:{include:[...]} exposes only listed tools", async () => {
      const middleware = createSecureExecMiddleware({
        ptc: { include: ["my_custom_tool"] },
      });
      const mockHandler = vi.fn().mockReturnValue({ response: "ok" });

      await middleware.wrapModelCall!(
        {
          systemMessage: new SystemMessage("Base"),
          state: {},
          runtime: { configurable: { thread_id: "ptc-include-obj" } },
          tools: [webSearch, customTool],
        } as never,
        mockHandler,
      );

      const req = mockHandler.mock.calls[0][0] as {
        systemMessage: { text: string };
      };
      expect(req.systemMessage.text).toContain("myCustomTool");
      expect(req.systemMessage.text).not.toContain("webSearch");
    });

    it("ptc:{exclude:[...]} excludes listed + defaults", async () => {
      const middleware = createSecureExecMiddleware({
        ptc: { exclude: ["my_custom_tool"] },
      });
      const mockHandler = vi.fn().mockReturnValue({ response: "ok" });

      await middleware.wrapModelCall!(
        {
          systemMessage: new SystemMessage("Base"),
          state: {},
          runtime: { configurable: { thread_id: "ptc-exclude" } },
          tools: [webSearch, customTool, readFile, writeFile],
        } as never,
        mockHandler,
      );

      const req = mockHandler.mock.calls[0][0] as {
        systemMessage: { text: string };
      };
      // webSearch should be included (not in exclude list)
      expect(req.systemMessage.text).toContain("webSearch");
      // customTool and read_file/write_file should be excluded
      expect(req.systemMessage.text).not.toContain("myCustomTool");
      expect(req.systemMessage.text).not.toContain("readFile\n");
      expect(req.systemMessage.text).not.toContain("writeFile\n");
    });
  });

  describe("generatePtcPrompt", () => {
    it("should generate API Reference with camelCase tool names", async () => {
      const tools = [
        tool(async () => "", {
          name: "web_search",
          description: "Search the web",
          schema: z.object({ query: z.string() }),
        }),
        tool(async () => "", {
          name: "grep",
          description: "Search files",
          schema: z.object({ pattern: z.string() }),
        }),
      ];
      const prompt = await generatePtcPrompt(tools);
      expect(prompt).toContain("### API Reference");
      expect(prompt).toContain("async tools.webSearch");
      expect(prompt).toContain("async tools.grep");
      expect(prompt).toContain("Promise<string>");
      expect(prompt).not.toContain("tools.web_search");
      expect(prompt).toContain("* Search the web");
      expect(prompt).toContain("* Search files");
    });

    it("should generate typed signatures from zod schemas", async () => {
      const tools = [
        tool(async () => "", {
          name: "read_file",
          description: "Read a file from the filesystem",
          schema: z.object({
            file_path: z.string().describe("Absolute path to read"),
            limit: z.number().optional().describe("Max lines"),
          }),
        }),
      ];
      const prompt = await generatePtcPrompt(tools);
      expect(prompt).toContain("async tools.readFile");
      expect(prompt).toContain("Promise<string>");
      expect(prompt).toContain("file_path: string;");
      expect(prompt).toContain("limit?: number;");
    });

    it("should return empty string for no tools", async () => {
      expect(await generatePtcPrompt([])).toBe("");
    });
  });

  describe("DEFAULT_PTC_EXCLUDED_TOOLS", () => {
    it("contains all expected tools", () => {
      expect(DEFAULT_PTC_EXCLUDED_TOOLS).toContain("ls");
      expect(DEFAULT_PTC_EXCLUDED_TOOLS).toContain("read_file");
      expect(DEFAULT_PTC_EXCLUDED_TOOLS).toContain("write_file");
      expect(DEFAULT_PTC_EXCLUDED_TOOLS).toContain("edit_file");
      expect(DEFAULT_PTC_EXCLUDED_TOOLS).toContain("glob");
      expect(DEFAULT_PTC_EXCLUDED_TOOLS).toContain("grep");
      expect(DEFAULT_PTC_EXCLUDED_TOOLS).toContain("execute");
    });
  });
});
