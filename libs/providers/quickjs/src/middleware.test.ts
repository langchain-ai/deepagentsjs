import { describe, it, expect, vi, beforeEach } from "vitest";
import { tool } from "langchain";
import * as z from "zod";
import { SystemMessage } from "@langchain/core/messages";
import { createQuickJSMiddleware, generatePtcPrompt } from "./middleware.js";
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
    });

    it("should register exactly one tool", () => {
      const middleware = createQuickJSMiddleware();
      expect(middleware.tools!.length).toBe(1);
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
      expect(text).toContain("### First-time usage");
      expect(text).toContain("### API Reference");
      expect(text).toContain("async readFile(path: string): Promise<string>");
      expect(text).toContain(
        "async writeFile(path: string, content: string): Promise<void>",
      );
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
});
