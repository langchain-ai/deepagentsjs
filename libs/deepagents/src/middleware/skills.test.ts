import { describe, it, expect, vi } from "vitest";
import { createSkillsMiddleware } from "./skills.js";
import type {
  BackendProtocol,
  FileDownloadResponse,
  FileInfo,
} from "../backends/protocol.js";

// Mock backend that returns specified files and directory listings
function createMockBackend(config: {
  files: Record<string, string | null>;
  directories: Record<
    string,
    Array<{ name: string; type: "file" | "directory" }>
  >;
}): BackendProtocol {
  return {
    async downloadFiles(paths: string[]): Promise<FileDownloadResponse[]> {
      return paths.map((path) => {
        const content = config.files[path];
        if (content === null || content === undefined) {
          return { path, error: "file_not_found", content: null };
        }
        return {
          path,
          content: new TextEncoder().encode(content),
          error: null,
        };
      });
    },
    async lsInfo(dirPath: string): Promise<FileInfo[]> {
      const entries = config.directories[dirPath];
      if (!entries) {
        throw new Error(`Directory not found: ${dirPath}`);
      }
      // Convert test format to FileInfo format
      return entries.map((entry) => ({
        path: entry.name + (entry.type === "directory" ? "/" : ""),
        is_dir: entry.type === "directory",
      }));
    },
    // Implement other required methods as stubs
    readFiles: vi.fn(),
    writeFile: vi.fn(),
    editFile: vi.fn(),
    grep: vi.fn(),
  } as unknown as BackendProtocol;
}

const VALID_SKILL_CONTENT = `---
name: web-research
description: Structured approach to conducting thorough web research
---

# Web Research Skill

## When to Use
- User asks you to research a topic
`;

const VALID_SKILL_CONTENT_2 = `---
name: code-review
description: Systematic code review process with best practices
---

# Code Review Skill

## Steps
1. Check for bugs
2. Check for style
`;

describe("createSkillsMiddleware", () => {
  describe("beforeAgent", () => {
    it("should load skills from configured sources", async () => {
      const mockBackend = createMockBackend({
        files: {
          "/skills/user/web-research/SKILL.md": VALID_SKILL_CONTENT,
        },
        directories: {
          "/skills/user/": [{ name: "web-research", type: "directory" }],
        },
      });

      const middleware = createSkillsMiddleware({
        backend: mockBackend,
        sources: ["/skills/user/"],
      });

      // @ts-expect-error - typing issue in LangChain
      const result = await middleware.beforeAgent?.({});

      expect(result).toBeDefined();
      expect(result?.skillsMetadata).toHaveLength(1);
      expect(result?.skillsMetadata[0].name).toBe("web-research");
      expect(result?.skillsMetadata[0].description).toBe(
        "Structured approach to conducting thorough web research",
      );
      expect(result?.skillsMetadata[0].path).toBe(
        "/skills/user/web-research/SKILL.md",
      );
    });

    it("should load skills from multiple sources", async () => {
      const mockBackend = createMockBackend({
        files: {
          "/skills/user/web-research/SKILL.md": VALID_SKILL_CONTENT,
          "/skills/project/code-review/SKILL.md": VALID_SKILL_CONTENT_2,
        },
        directories: {
          "/skills/user/": [{ name: "web-research", type: "directory" }],
          "/skills/project/": [{ name: "code-review", type: "directory" }],
        },
      });

      const middleware = createSkillsMiddleware({
        backend: mockBackend,
        sources: ["/skills/user/", "/skills/project/"],
      });

      // @ts-expect-error - typing issue in LangChain
      const result = await middleware.beforeAgent?.({});

      expect(result).toBeDefined();
      expect(result?.skillsMetadata).toHaveLength(2);
      expect(result?.skillsMetadata.map((s: any) => s.name).sort()).toEqual([
        "code-review",
        "web-research",
      ]);
    });

    it("should override earlier sources with later sources (last wins)", async () => {
      const userSkillContent = `---
name: web-research
description: User version of web research
---
# User Skill`;

      const projectSkillContent = `---
name: web-research
description: Project version of web research
---
# Project Skill`;

      const mockBackend = createMockBackend({
        files: {
          "/skills/user/web-research/SKILL.md": userSkillContent,
          "/skills/project/web-research/SKILL.md": projectSkillContent,
        },
        directories: {
          "/skills/user/": [{ name: "web-research", type: "directory" }],
          "/skills/project/": [{ name: "web-research", type: "directory" }],
        },
      });

      const middleware = createSkillsMiddleware({
        backend: mockBackend,
        sources: ["/skills/user/", "/skills/project/"],
      });

      // @ts-expect-error - typing issue in LangChain
      const result = await middleware.beforeAgent?.({});

      expect(result).toBeDefined();
      expect(result?.skillsMetadata).toHaveLength(1);
      expect(result?.skillsMetadata[0].description).toBe(
        "Project version of web research",
      );
    });

    it("should handle empty sources gracefully", async () => {
      const mockBackend = createMockBackend({
        files: {},
        directories: {
          "/skills/empty/": [],
        },
      });

      const middleware = createSkillsMiddleware({
        backend: mockBackend,
        sources: ["/skills/empty/"],
      });

      // @ts-expect-error - typing issue in LangChain
      const result = await middleware.beforeAgent?.({});

      expect(result).toBeDefined();
      expect(result?.skillsMetadata).toEqual([]);
    });

    it("should skip skills without SKILL.md", async () => {
      const mockBackend = createMockBackend({
        files: {
          // No SKILL.md file
        },
        directories: {
          "/skills/user/": [{ name: "incomplete-skill", type: "directory" }],
        },
      });

      const middleware = createSkillsMiddleware({
        backend: mockBackend,
        sources: ["/skills/user/"],
      });

      // @ts-expect-error - typing issue in LangChain
      const result = await middleware.beforeAgent?.({});

      expect(result?.skillsMetadata).toEqual([]);
    });

    it("should skip skills with invalid frontmatter", async () => {
      const invalidContent = `# No YAML frontmatter
This skill has no valid frontmatter.`;

      const mockBackend = createMockBackend({
        files: {
          "/skills/user/invalid/SKILL.md": invalidContent,
        },
        directories: {
          "/skills/user/": [{ name: "invalid", type: "directory" }],
        },
      });

      const middleware = createSkillsMiddleware({
        backend: mockBackend,
        sources: ["/skills/user/"],
      });

      // @ts-expect-error - typing issue in LangChain
      const result = await middleware.beforeAgent?.({});

      expect(result?.skillsMetadata).toEqual([]);
    });

    it("should skip if skillsMetadata already in state", async () => {
      const mockBackend = createMockBackend({
        files: {
          "/skills/user/web-research/SKILL.md": VALID_SKILL_CONTENT,
        },
        directories: {
          "/skills/user/": [{ name: "web-research", type: "directory" }],
        },
      });

      const middleware = createSkillsMiddleware({
        backend: mockBackend,
        sources: ["/skills/user/"],
      });

      const existingMetadata = [
        { name: "cached", description: "cached skill" },
      ];
      // @ts-expect-error - typing issue in LangChain
      const result = await middleware.beforeAgent?.({
        skillsMetadata: existingMetadata,
      });

      expect(result).toBeUndefined();
    });

    it("should work with backend factory function", async () => {
      const mockBackend = createMockBackend({
        files: {
          "/skills/factory/web-research/SKILL.md": VALID_SKILL_CONTENT,
        },
        directories: {
          "/skills/factory/": [{ name: "web-research", type: "directory" }],
        },
      });

      const backendFactory = vi.fn().mockReturnValue(mockBackend);

      const middleware = createSkillsMiddleware({
        backend: backendFactory,
        sources: ["/skills/factory/"],
      });

      // @ts-expect-error - typing issue in LangChain
      const result = await middleware.beforeAgent?.({});

      expect(backendFactory).toHaveBeenCalled();
      expect(result?.skillsMetadata).toHaveLength(1);
    });
  });

  describe("wrapModelCall", () => {
    it("should inject skills into system prompt", () => {
      const middleware = createSkillsMiddleware({
        backend: createMockBackend({ files: {}, directories: {} }),
        sources: ["/skills/user/", "/skills/project/"],
      });

      const mockHandler = vi.fn().mockReturnValue({ response: "ok" });
      const request: any = {
        systemPrompt: "Base prompt",
        state: {
          skillsMetadata: [
            {
              name: "web-research",
              description: "Research the web",
              path: "/skills/user/web-research/SKILL.md",
            },
          ],
        },
      };

      middleware.wrapModelCall!(request, mockHandler);

      expect(mockHandler).toHaveBeenCalled();
      const modifiedRequest = mockHandler.mock.calls[0][0];
      expect(modifiedRequest.systemPrompt).toContain("Skills System");
      expect(modifiedRequest.systemPrompt).toContain("web-research");
      expect(modifiedRequest.systemPrompt).toContain("Research the web");
      expect(modifiedRequest.systemPrompt).toContain(
        "/skills/user/web-research/SKILL.md",
      );
    });

    it("should show message when no skills available", () => {
      const middleware = createSkillsMiddleware({
        backend: createMockBackend({ files: {}, directories: {} }),
        sources: ["/skills/user/"],
      });

      const mockHandler = vi.fn().mockReturnValue({ response: "ok" });
      const request: any = {
        systemPrompt: "Base prompt",
        state: { skillsMetadata: [] },
      };

      middleware.wrapModelCall!(request, mockHandler);

      const modifiedRequest = mockHandler.mock.calls[0][0];
      expect(modifiedRequest.systemPrompt).toContain("No skills available yet");
    });

    it("should append skills section to existing system prompt", () => {
      const middleware = createSkillsMiddleware({
        backend: createMockBackend({ files: {}, directories: {} }),
        sources: [],
      });

      const mockHandler = vi.fn().mockReturnValue({ response: "ok" });
      const request: any = {
        systemPrompt: "Original system prompt content",
        state: { skillsMetadata: [] },
      };

      middleware.wrapModelCall!(request, mockHandler);

      const modifiedRequest = mockHandler.mock.calls[0][0];
      // Original prompt should come before skills section
      const originalIndex = modifiedRequest.systemPrompt.indexOf(
        "Original system prompt content",
      );
      const skillsIndex = modifiedRequest.systemPrompt.indexOf("Skills System");
      expect(originalIndex).toBeLessThan(skillsIndex);
    });
  });

  describe("integration", () => {
    it("should work end-to-end: load skills and inject into prompt", async () => {
      const mockBackend = createMockBackend({
        files: {
          "/skills/user/web-research/SKILL.md": VALID_SKILL_CONTENT,
          "/skills/project/code-review/SKILL.md": VALID_SKILL_CONTENT_2,
        },
        directories: {
          "/skills/user/": [{ name: "web-research", type: "directory" }],
          "/skills/project/": [{ name: "code-review", type: "directory" }],
        },
      });

      const middleware = createSkillsMiddleware({
        backend: mockBackend,
        sources: ["/skills/user/", "/skills/project/"],
      });

      // Step 1: Load skills
      // @ts-expect-error - typing issue in LangChain
      const stateUpdate = await middleware.beforeAgent?.({});
      expect(stateUpdate?.skillsMetadata).toHaveLength(2);

      // Step 2: Inject skills into prompt
      const mockHandler = vi.fn().mockReturnValue({ response: "ok" });
      const request: any = {
        systemPrompt: "You are a helpful assistant.",
        state: stateUpdate,
      };

      middleware.wrapModelCall!(request, mockHandler);

      const modifiedRequest = mockHandler.mock.calls[0][0];
      expect(modifiedRequest.systemPrompt).toContain("web-research");
      expect(modifiedRequest.systemPrompt).toContain("code-review");
      expect(modifiedRequest.systemPrompt).toContain(
        "You are a helpful assistant",
      );
    });
  });
});
