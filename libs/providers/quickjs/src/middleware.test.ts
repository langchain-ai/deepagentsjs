import { describe, it, expect, vi, beforeEach } from "vitest";
import { tool } from "langchain";
import * as z from "zod";
import { SystemMessage } from "@langchain/core/messages";
import {
  createQuickJSMiddleware,
  generatePtcPrompt,
  resolveToolList,
} from "./middleware.js";
import { ReplSession } from "./session.js";

describe("createQuickJSMiddleware", () => {
  beforeEach(() => {
    ReplSession.clearCache();
  });

  describe("tool registration", () => {
    it("should register js_eval tool", () => {
      const middleware = createQuickJSMiddleware();
      expect(middleware.tools).toBeDefined();
      const names = middleware.tools!.map((t: { name: string }) => t.name);
      expect(names).toContain("js_eval");
      const jsEval = middleware.tools!.find(
        (t: { name: string }) => t.name === "js_eval",
      ) as {
        metadata?: Record<string, unknown>;
      };
      expect(jsEval.metadata?.ls_code_input_language).toBe("javascript");
    });

    it("should register exactly one tool", () => {
      const middleware = createQuickJSMiddleware();
      expect(middleware.tools!.length).toBe(1);
      expect(
        (middleware.tools![0] as { metadata?: Record<string, unknown> })
          .metadata,
      ).toMatchObject({ ls_code_input_language: "javascript" });
    });
  });

  describe("wrapModelCall", () => {
    it("should add REPL system prompt with API Reference structure", async () => {
      const middleware = createQuickJSMiddleware();
      const mockHandler = vi.fn().mockReturnValue({ response: "ok" });

      await middleware.wrapModelCall!(
        {
          systemMessage: new SystemMessage("Base"),
          state: {},
          runtime: { configurable: { thread_id: "test-1" } },
          tools: middleware.tools || [],
        } as any,
        mockHandler,
      );

      const req = mockHandler.mock.calls[0][0];
      const text = req.systemMessage.text;
      expect(text).toContain("Base");
      expect(text).toContain("js_eval");
      expect(text).toContain("### Hard rules");
      expect(text).toContain("### Limitations");
      expect(text).not.toContain("async readFile");
      expect(text).not.toContain("async writeFile");
      expect(text).not.toContain("### First-time usage");
    });

    it("should use custom system prompt when provided", async () => {
      const middleware = createQuickJSMiddleware({
        systemPrompt: "Custom REPL prompt",
      });
      const mockHandler = vi.fn().mockReturnValue({ response: "ok" });

      await middleware.wrapModelCall!(
        {
          systemMessage: new SystemMessage("Base"),
          state: {},
          runtime: { configurable: { thread_id: "test-2" } },
          tools: middleware.tools || [],
        } as any,
        mockHandler,
      );

      const req = mockHandler.mock.calls[0][0];
      expect(req.systemMessage.text).toContain("Custom REPL prompt");
      expect(req.systemMessage.text).not.toContain("Hard rules");
    });
  });

  describe("resolveToolList", () => {
    const agentSearch = tool(async () => "results", {
      name: "search",
      description: "Search",
      schema: z.object({ query: z.string() }),
    });
    const agentGrep = tool(async () => "matches", {
      name: "grep",
      description: "Grep",
      schema: z.object({ pattern: z.string() }),
    });
    const extraTool = tool(async () => "extra", {
      name: "extra_tool",
      description: "Not on agent",
      schema: z.object({}),
    });

    it("should resolve string entries from agentTools", () => {
      const result = resolveToolList(["search"], [agentSearch, agentGrep]);
      expect(result).toHaveLength(1);
      expect(result[0]).toBe(agentSearch);
    });

    it("should include tool instances directly without agent lookup", () => {
      const result = resolveToolList([extraTool], [agentSearch]);
      expect(result).toHaveLength(1);
      expect(result[0]).toBe(extraTool);
    });

    it("should handle a mixed list of strings and instances", () => {
      const result = resolveToolList(
        ["search", extraTool],
        [agentSearch, agentGrep],
      );
      expect(result).toHaveLength(2);
      expect(result[0]).toBe(agentSearch);
      expect(result[1]).toBe(extraTool);
    });

    it("should silently omit strings that don't match any agent tool", () => {
      const result = resolveToolList(["nonexistent"], [agentSearch]);
      expect(result).toHaveLength(0);
    });

    it("should include instance even if its name matches an agent tool", () => {
      const customSearch = tool(async () => "custom", {
        name: "search",
        description: "Custom search",
        schema: z.object({}),
      });
      const result = resolveToolList([customSearch], [agentSearch]);
      expect(result).toHaveLength(1);
      expect(result[0]).toBe(customSearch);
      expect(result[0]).not.toBe(agentSearch);
    });

    it("should return empty array for empty items list", () => {
      expect(resolveToolList([], [agentSearch])).toHaveLength(0);
    });
  });

  describe("ptc with tool instances via wrapModelCall", () => {
    const agentTool = tool(async () => "agent result", {
      name: "agent_tool",
      description: "Agent tool",
      schema: z.object({ q: z.string() }),
    });
    const extraTool = tool(async () => "extra result", {
      name: "extra_tool",
      description: "Not on agent",
      schema: z.object({}),
    });

    it("should include directly injected instances in PTC prompt", async () => {
      const middleware = createQuickJSMiddleware({ ptc: [extraTool] });
      const mockHandler = vi.fn().mockReturnValue({ response: "ok" });

      await middleware.wrapModelCall!(
        {
          systemMessage: new SystemMessage("Base"),
          state: {},
          runtime: { configurable: { thread_id: "ptc-inst-1" } },
          tools: [],
        } as any,
        mockHandler,
      );

      const req = mockHandler.mock.calls[0][0];
      expect(req.systemMessage.text).toContain("tools.extraTool");
    });

    it("should include both named agent tools and injected instances in mixed ptc array", async () => {
      const middleware = createQuickJSMiddleware({
        ptc: ["agent_tool", extraTool],
      });
      const mockHandler = vi.fn().mockReturnValue({ response: "ok" });

      await middleware.wrapModelCall!(
        {
          systemMessage: new SystemMessage("Base"),
          state: {},
          runtime: { configurable: { thread_id: "ptc-mixed-1" } },
          tools: [agentTool],
        } as any,
        mockHandler,
      );

      const req = mockHandler.mock.calls[0][0];
      expect(req.systemMessage.text).toContain("tools.agentTool");
      expect(req.systemMessage.text).toContain("tools.extraTool");
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
      expect(prompt).toContain("Absolute path to read");
      expect(prompt).toContain("Max lines");
    });

    it("should return empty string for no tools", async () => {
      expect(await generatePtcPrompt([])).toBe("");
    });
  });

  describe("afterAgent call", () => {
    it("should dispose of the session for the current thread", async () => {
      const middleware = createQuickJSMiddleware();

      // Trigger session creation via js_eval
      const jsTool = middleware.tools!.find(
        (t: any) => t.name === "js_eval",
      ) as any;
      await jsTool.invoke(
        { code: "1 + 1" },
        { configurable: { thread_id: "cleanup-test" } },
      );

      expect(ReplSession.hasAnyForThread("cleanup-test")).toBe(true);

      // Fire afterAgent
      await (middleware as any).afterAgent(
        {},
        { configurable: { thread_id: "cleanup-test" } },
      );

      expect(ReplSession.hasAnyForThread("cleanup-test")).toBe(false);
    });

    it("should no-op for afterAgent on a thread with no session", async () => {
      const middleware = createQuickJSMiddleware();
      await expect(
        (middleware as any).afterAgent(
          {},
          { configurable: { thread_id: "no-session-thread" } },
        ),
      ).resolves.not.toThrow();
    });

    it("should only remove the session for the finished thread, not others", async () => {
      const middleware = createQuickJSMiddleware();
      const jsTool = middleware.tools!.find(
        (t: any) => t.name === "js_eval",
      ) as any;

      await jsTool.invoke(
        { code: "1" },
        { configurable: { thread_id: "thread-a" } },
      );
      await jsTool.invoke(
        { code: "1" },
        { configurable: { thread_id: "thread-b" } },
      );

      await (middleware as any).afterAgent(
        {},
        { configurable: { thread_id: "thread-a" } },
      );

      expect(ReplSession.hasAnyForThread("thread-a")).toBe(false);
      expect(ReplSession.hasAnyForThread("thread-b")).toBe(true);
    });
  });
});
