import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { createAgentMemoryMiddleware } from "./agent-memory.js";
import type { Settings } from "../config.js";
import type { MiddlewareHandler } from "./types.js";

describe("Agent Memory Middleware", () => {
  let tempDir: string;
  let mockSettings: Settings;
  let userAgentDir: string;
  let projectAgentDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "deepagents-memory-mw-test-"),
    );

    // Create user and project agent directories
    userAgentDir = path.join(tempDir, ".deepagents", "test-agent");
    projectAgentDir = path.join(tempDir, "project", ".deepagents");
    fs.mkdirSync(userAgentDir, { recursive: true });
    fs.mkdirSync(projectAgentDir, { recursive: true });

    // Create .git in project for detection
    fs.mkdirSync(path.join(tempDir, "project", ".git"), { recursive: true });

    // Mock settings that point to our test directories
    mockSettings = {
      projectRoot: path.join(tempDir, "project"),
      userDeepagentsDir: path.join(tempDir, ".deepagents"),
      hasProject: true,
      getAgentDir: (name: string) => path.join(tempDir, ".deepagents", name),
      ensureAgentDir: (name: string) => {
        const dir = path.join(tempDir, ".deepagents", name);
        fs.mkdirSync(dir, { recursive: true });
        return dir;
      },
      getUserAgentMdPath: (name: string) =>
        path.join(tempDir, ".deepagents", name, "agent.md"),
      getProjectAgentMdPath: () =>
        path.join(tempDir, "project", ".deepagents", "agent.md"),
      getUserSkillsDir: (name: string) =>
        path.join(tempDir, ".deepagents", name, "skills"),
      ensureUserSkillsDir: (name: string) => {
        const dir = path.join(tempDir, ".deepagents", name, "skills");
        fs.mkdirSync(dir, { recursive: true });
        return dir;
      },
      getProjectSkillsDir: () =>
        path.join(tempDir, "project", ".deepagents", "skills"),
      ensureProjectSkillsDir: () => {
        const dir = path.join(tempDir, "project", ".deepagents", "skills");
        fs.mkdirSync(dir, { recursive: true });
        return dir;
      },
      ensureProjectDeepagentsDir: () => {
        const dir = path.join(tempDir, "project", ".deepagents");
        fs.mkdirSync(dir, { recursive: true });
        return dir;
      },
    };
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe("createAgentMemoryMiddleware", () => {
    it("should create middleware with correct name", () => {
      const middleware = createAgentMemoryMiddleware({
        settings: mockSettings,
        assistantId: "test-agent",
      });

      expect(middleware.name).toBe("AgentMemoryMiddleware");
    });

    it("should have beforeAgent and wrapModelCall hooks", () => {
      const middleware = createAgentMemoryMiddleware({
        settings: mockSettings,
        assistantId: "test-agent",
      });

      expect(middleware.beforeAgent).toBeDefined();
      expect(middleware.wrapModelCall).toBeDefined();
    });
  });

  describe("beforeAgent hook", () => {
    it("should load user memory from agent.md", () => {
      const userMemoryContent =
        "# User Preferences\n\n- Be concise\n- Use TypeScript";
      fs.writeFileSync(path.join(userAgentDir, "agent.md"), userMemoryContent);

      const middleware = createAgentMemoryMiddleware({
        settings: mockSettings,
        assistantId: "test-agent",
      });

      const result = (middleware.beforeAgent as MiddlewareHandler)({}, {});

      expect(result).toBeDefined();
      expect(result!.userMemory).toBe(userMemoryContent);
    });

    it("should load project memory from agent.md", () => {
      const projectMemoryContent =
        "# Project Instructions\n\n- Use FastAPI\n- Write tests";
      fs.writeFileSync(
        path.join(projectAgentDir, "agent.md"),
        projectMemoryContent,
      );

      const middleware = createAgentMemoryMiddleware({
        settings: mockSettings,
        assistantId: "test-agent",
      });

      const result = (middleware.beforeAgent as MiddlewareHandler)({}, {});

      expect(result).toBeDefined();
      expect(result!.projectMemory).toBe(projectMemoryContent);
    });

    it("should load both user and project memory", () => {
      const userMemoryContent = "User memory content";
      const projectMemoryContent = "Project memory content";

      fs.writeFileSync(path.join(userAgentDir, "agent.md"), userMemoryContent);
      fs.writeFileSync(
        path.join(projectAgentDir, "agent.md"),
        projectMemoryContent,
      );

      const middleware = createAgentMemoryMiddleware({
        settings: mockSettings,
        assistantId: "test-agent",
      });

      const result = (middleware.beforeAgent as MiddlewareHandler)({}, {});

      expect(result!.userMemory).toBe(userMemoryContent);
      expect(result!.projectMemory).toBe(projectMemoryContent);
    });

    it("should handle missing user memory gracefully", () => {
      const middleware = createAgentMemoryMiddleware({
        settings: mockSettings,
        assistantId: "test-agent",
      });

      const result = (middleware.beforeAgent as MiddlewareHandler)({}, {});

      expect(result).toBeUndefined();
    });

    it("should handle missing project memory gracefully", () => {
      const userMemoryContent = "User memory only";
      fs.writeFileSync(path.join(userAgentDir, "agent.md"), userMemoryContent);

      const middleware = createAgentMemoryMiddleware({
        settings: mockSettings,
        assistantId: "test-agent",
      });

      const result = (middleware.beforeAgent as MiddlewareHandler)({}, {});

      expect(result!.userMemory).toBe(userMemoryContent);
      expect(result!.projectMemory).toBeUndefined();
    });

    it("should not reload memory if already in state", () => {
      const userMemoryContent = "Original user memory";
      fs.writeFileSync(path.join(userAgentDir, "agent.md"), userMemoryContent);

      const middleware = createAgentMemoryMiddleware({
        settings: mockSettings,
        assistantId: "test-agent",
      });

      // First call loads memory
      const existingState = {
        userMemory: "Already loaded",
        projectMemory: "Already loaded project",
      };

      const result = (middleware.beforeAgent as MiddlewareHandler)(
        existingState,
        {},
      );

      // Should return undefined since memory already exists in state
      expect(result).toBeUndefined();
    });
  });

  describe("wrapModelCall hook", () => {
    it("should inject user memory content into system prompt", async () => {
      const userMemoryContent = "User preferences here";
      fs.writeFileSync(path.join(userAgentDir, "agent.md"), userMemoryContent);

      const middleware = createAgentMemoryMiddleware({
        settings: mockSettings,
        assistantId: "test-agent",
      });

      const stateUpdate = (middleware.beforeAgent as MiddlewareHandler)({}, {});

      let capturedRequest: any;
      const handler = vi.fn((request: any) => {
        capturedRequest = request;
        return Promise.resolve({ messages: [] });
      });

      await (middleware.wrapModelCall as MiddlewareHandler)(
        {
          systemPrompt: "",
          state: stateUpdate,
        },
        handler,
      );

      expect(capturedRequest.systemPrompt).toContain("<user_memory>");
      expect(capturedRequest.systemPrompt).toContain(userMemoryContent);
      expect(capturedRequest.systemPrompt).toContain("</user_memory>");
    });

    it("should inject project memory content into system prompt", async () => {
      const projectMemoryContent = "Project instructions here";
      fs.writeFileSync(
        path.join(projectAgentDir, "agent.md"),
        projectMemoryContent,
      );

      const middleware = createAgentMemoryMiddleware({
        settings: mockSettings,
        assistantId: "test-agent",
      });

      const stateUpdate = (middleware.beforeAgent as MiddlewareHandler)({}, {});

      let capturedRequest: any;
      const handler = vi.fn((request: any) => {
        capturedRequest = request;
        return Promise.resolve({ messages: [] });
      });

      await (middleware.wrapModelCall as MiddlewareHandler)(
        {
          systemPrompt: "",
          state: stateUpdate,
        },
        handler,
      );

      expect(capturedRequest.systemPrompt).toContain("<project_memory>");
      expect(capturedRequest.systemPrompt).toContain(projectMemoryContent);
      expect(capturedRequest.systemPrompt).toContain("</project_memory>");
    });

    it("should inject long-term memory documentation", async () => {
      const middleware = createAgentMemoryMiddleware({
        settings: mockSettings,
        assistantId: "test-agent",
      });

      let capturedRequest: any;
      const handler = vi.fn((request: any) => {
        capturedRequest = request;
        return Promise.resolve({ messages: [] });
      });

      await (middleware.wrapModelCall as MiddlewareHandler)(
        {
          systemPrompt: "",
          state: {},
        },
        handler,
      );

      expect(capturedRequest.systemPrompt).toContain("## Long-term Memory");
      expect(capturedRequest.systemPrompt).toContain(
        "When to CHECK/READ memories",
      );
      expect(capturedRequest.systemPrompt).toContain("When to update memories");
    });

    it("should preserve base system prompt", async () => {
      const middleware = createAgentMemoryMiddleware({
        settings: mockSettings,
        assistantId: "test-agent",
      });

      let capturedRequest: any;
      const handler = vi.fn((request: any) => {
        capturedRequest = request;
        return Promise.resolve({ messages: [] });
      });

      await (middleware.wrapModelCall as MiddlewareHandler)(
        {
          systemPrompt: "You are a helpful coding assistant.",
          state: {},
        },
        handler,
      );

      expect(capturedRequest.systemPrompt).toContain(
        "You are a helpful coding assistant.",
      );
    });

    it("should show placeholder when no memory files exist", async () => {
      const middleware = createAgentMemoryMiddleware({
        settings: mockSettings,
        assistantId: "test-agent",
      });

      let capturedRequest: any;
      const handler = vi.fn((request: any) => {
        capturedRequest = request;
        return Promise.resolve({ messages: [] });
      });

      await (middleware.wrapModelCall as MiddlewareHandler)(
        {
          systemPrompt: "",
          state: {},
        },
        handler,
      );

      expect(capturedRequest.systemPrompt).toContain("(No user agent.md)");
      expect(capturedRequest.systemPrompt).toContain("(No project agent.md)");
    });

    it("should use custom system prompt template if provided", async () => {
      const customTemplate = "USER: {user_memory}\nPROJECT: {project_memory}";
      const userMemoryContent = "My preferences";
      const projectMemoryContent = "My project";

      fs.writeFileSync(path.join(userAgentDir, "agent.md"), userMemoryContent);
      fs.writeFileSync(
        path.join(projectAgentDir, "agent.md"),
        projectMemoryContent,
      );

      const middleware = createAgentMemoryMiddleware({
        settings: mockSettings,
        assistantId: "test-agent",
        systemPromptTemplate: customTemplate,
      });

      const stateUpdate = (middleware.beforeAgent as MiddlewareHandler)({}, {});

      let capturedRequest: any;
      const handler = vi.fn((request: any) => {
        capturedRequest = request;
        return Promise.resolve({ messages: [] });
      });

      await (middleware.wrapModelCall as MiddlewareHandler)(
        {
          systemPrompt: "",
          state: stateUpdate,
        },
        handler,
      );

      expect(capturedRequest.systemPrompt).toContain("USER: My preferences");
      expect(capturedRequest.systemPrompt).toContain("PROJECT: My project");
    });
  });
});
