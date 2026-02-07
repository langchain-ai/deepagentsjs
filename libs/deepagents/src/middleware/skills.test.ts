import { describe, it, expect, vi } from "vitest";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import {
  HumanMessage,
  SystemMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { MemorySaver } from "@langchain/langgraph";

import {
  createSkillsMiddleware,
  skillsMetadataReducer,
  type SkillMetadataEntry,
} from "./skills.js";
import { createFileData } from "../backends/utils.js";
import { createDeepAgent } from "../agent.js";
import { createMockBackend } from "./test.js";
import type { BackendProtocol } from "../backends/protocol.js";

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

    it("should skip skills exceeding MAX_SKILL_FILE_SIZE (10MB)", async () => {
      // Create a skill content larger than 10MB
      const largeFrontmatter = `---
name: large-skill
description: A skill with very large content
---
`;
      const largeContent = largeFrontmatter + "x".repeat(10 * 1024 * 1024 + 1); // 10MB + 1 byte

      const mockBackend = createMockBackend({
        files: {
          "/skills/user/large-skill/SKILL.md": largeContent,
        },
        directories: {
          "/skills/user/": [{ name: "large-skill", type: "directory" }],
        },
      });

      const middleware = createSkillsMiddleware({
        backend: mockBackend,
        sources: ["/skills/user/"],
      });

      const consoleWarnSpy = vi
        .spyOn(console, "warn")
        .mockImplementation(() => {});

      // @ts-expect-error - typing issue in LangChain
      const result = await middleware.beforeAgent?.({});

      // Should skip the large skill
      expect(result?.skillsMetadata).toEqual([]);
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining("content too large"),
      );

      consoleWarnSpy.mockRestore();
    });

    it("should continue loading from other sources when one source fails", async () => {
      const mockBackend = createMockBackend({
        files: {
          "/skills/good/web-research/SKILL.md": VALID_SKILL_CONTENT,
        },
        directories: {
          "/skills/good/": [{ name: "web-research", type: "directory" }],
          // /skills/bad/ not in directories, so lsInfo will fail
        },
      });

      const middleware = createSkillsMiddleware({
        backend: mockBackend,
        sources: ["/skills/bad/", "/skills/good/"],
      });

      // @ts-expect-error - typing issue in LangChain
      const result = await middleware.beforeAgent?.({});

      // Should load from /skills/good/ even though /skills/bad/ failed
      expect(result?.skillsMetadata).toHaveLength(1);
      expect(result?.skillsMetadata[0].name).toBe("web-research");
    });

    it("should use backend.read() fallback when downloadFiles is not available", async () => {
      const mockBackend = {
        async lsInfo(dirPath: string) {
          if (dirPath === "/skills/user/") {
            return [
              {
                path: "web-research/",
                is_dir: true,
              },
            ];
          }
          return [];
        },
        async read(path: string) {
          if (path === "/skills/user/web-research/SKILL.md") {
            return VALID_SKILL_CONTENT;
          }
          return "Error: file not found";
        },
        // downloadFiles is NOT defined
        readFiles: vi.fn(),
        write: vi.fn(),
        edit: vi.fn(),
        grep: vi.fn(),
      } as unknown as BackendProtocol;

      const middleware = createSkillsMiddleware({
        backend: mockBackend,
        sources: ["/skills/user/"],
      });

      // @ts-expect-error - typing issue in LangChain
      const result = await middleware.beforeAgent?.({});

      expect(result?.skillsMetadata).toHaveLength(1);
      expect(result?.skillsMetadata[0].name).toBe("web-research");
    });

    it("should skip skill when backend.read() returns error", async () => {
      const mockBackend = {
        async lsInfo(dirPath: string) {
          if (dirPath === "/skills/user/") {
            return [
              {
                path: "broken-skill/",
                is_dir: true,
              },
            ];
          }
          return [];
        },
        async read(_path: string) {
          return "Error: permission denied";
        },
        readFiles: vi.fn(),
        write: vi.fn(),
        edit: vi.fn(),
        grep: vi.fn(),
      } as unknown as BackendProtocol;

      const middleware = createSkillsMiddleware({
        backend: mockBackend,
        sources: ["/skills/user/"],
      });

      // @ts-expect-error - typing issue in LangChain
      const result = await middleware.beforeAgent?.({});

      // Should skip the skill that returned error
      expect(result?.skillsMetadata).toEqual([]);
    });

    it("should not reload when skills are already loaded", async () => {
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

      // First call - should load skills
      // @ts-expect-error - typing issue in LangChain
      const result1 = await middleware.beforeAgent?.({});
      expect(result1?.skillsMetadata).toHaveLength(1);

      // Second call - should return undefined (already loaded in closure)
      // @ts-expect-error - typing issue in LangChain
      const result2 = await middleware.beforeAgent?.({});
      expect(result2).toBeUndefined();
    });

    it("should skip reload when skillsMetadata exists in checkpoint state", async () => {
      const mockBackend = createMockBackend({
        files: {},
        directories: {},
      });

      const middleware = createSkillsMiddleware({
        backend: mockBackend,
        sources: ["/skills/user/"],
      });

      // Simulate checkpoint restore scenario
      const checkpointState = {
        skillsMetadata: [
          {
            name: "restored-skill",
            description: "Restored from checkpoint",
            path: "/skills/user/restored-skill/SKILL.md",
          },
        ],
      };

      // @ts-expect-error - typing issue in LangChain
      const result = await middleware.beforeAgent?.(checkpointState);

      // Should return undefined (not reload)
      expect(result).toBeUndefined();
    });

    it("should truncate description exceeding 1024 characters", async () => {
      const longDescription = "A".repeat(1100); // 1100 chars (exceeds 1024 limit)
      const skillContent = `---
name: long-desc-skill
description: ${longDescription}
---

# Long Description Skill`;

      const mockBackend = createMockBackend({
        files: {
          "/skills/user/long-desc-skill/SKILL.md": skillContent,
        },
        directories: {
          "/skills/user/": [{ name: "long-desc-skill", type: "directory" }],
        },
      });

      const middleware = createSkillsMiddleware({
        backend: mockBackend,
        sources: ["/skills/user/"],
      });

      const consoleWarnSpy = vi
        .spyOn(console, "warn")
        .mockImplementation(() => {});

      // @ts-expect-error - typing issue in LangChain
      const result = await middleware.beforeAgent?.({});

      // Should truncate to 1024 characters
      expect(result?.skillsMetadata).toHaveLength(1);
      expect(result?.skillsMetadata[0].description).toHaveLength(1024);
      expect(result?.skillsMetadata[0].description).toBe("A".repeat(1024));
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Description exceeds 1024 characters"),
      );

      consoleWarnSpy.mockRestore();
    });

    it("should warn when skill name does not match directory name", async () => {
      const skillContent = `---
name: different-name
description: Skill with mismatched name
---

# Mismatched Name Skill`;

      const mockBackend = createMockBackend({
        files: {
          "/skills/user/actual-dir-name/SKILL.md": skillContent,
        },
        directories: {
          "/skills/user/": [{ name: "actual-dir-name", type: "directory" }],
        },
      });

      const middleware = createSkillsMiddleware({
        backend: mockBackend,
        sources: ["/skills/user/"],
      });

      const consoleWarnSpy = vi
        .spyOn(console, "warn")
        .mockImplementation(() => {});

      // @ts-expect-error - typing issue in LangChain
      const result = await middleware.beforeAgent?.({});

      // Should still load the skill (warning only, backwards compatible)
      expect(result?.skillsMetadata).toHaveLength(1);
      expect(result?.skillsMetadata[0].name).toBe("different-name");
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining("does not follow Agent Skills specification"),
      );
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining("must match directory name"),
      );

      consoleWarnSpy.mockRestore();
    });

    it("should warn when skill name has invalid format", async () => {
      const skillContent = `---
name: Invalid_Name_With_Underscores
description: Skill with invalid name format
---

# Invalid Name Skill`;

      const mockBackend = createMockBackend({
        files: {
          "/skills/user/Invalid_Name_With_Underscores/SKILL.md": skillContent,
        },
        directories: {
          "/skills/user/": [
            { name: "Invalid_Name_With_Underscores", type: "directory" },
          ],
        },
      });

      const middleware = createSkillsMiddleware({
        backend: mockBackend,
        sources: ["/skills/user/"],
      });

      const consoleWarnSpy = vi
        .spyOn(console, "warn")
        .mockImplementation(() => {});

      // @ts-expect-error - typing issue in LangChain
      const result = await middleware.beforeAgent?.({});

      // Should still load the skill (warning only)
      expect(result?.skillsMetadata).toHaveLength(1);
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining("does not follow Agent Skills specification"),
      );
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining("lowercase alphanumeric with single hyphens"),
      );

      consoleWarnSpy.mockRestore();
    });

    it("should parse license and compatibility from frontmatter", async () => {
      const skillContent = `---
name: licensed-skill
description: A skill with license and compatibility info
license: MIT
compatibility: node >= 18
---

# Licensed Skill`;

      const mockBackend = createMockBackend({
        files: {
          "/skills/user/licensed-skill/SKILL.md": skillContent,
        },
        directories: {
          "/skills/user/": [{ name: "licensed-skill", type: "directory" }],
        },
      });

      const middleware = createSkillsMiddleware({
        backend: mockBackend,
        sources: ["/skills/user/"],
      });

      // @ts-expect-error - typing issue in LangChain
      const result = await middleware.beforeAgent?.({});

      expect(result?.skillsMetadata).toHaveLength(1);
      expect(result?.skillsMetadata[0].license).toBe("MIT");
      expect(result?.skillsMetadata[0].compatibility).toBe("node >= 18");
    });

    it("should parse allowed-tools from frontmatter", async () => {
      const skillContent = `---
name: tools-skill
description: A skill with allowed tools
allowed-tools: read_file write_file grep
---

# Tools Skill`;

      const mockBackend = createMockBackend({
        files: {
          "/skills/user/tools-skill/SKILL.md": skillContent,
        },
        directories: {
          "/skills/user/": [{ name: "tools-skill", type: "directory" }],
        },
      });

      const middleware = createSkillsMiddleware({
        backend: mockBackend,
        sources: ["/skills/user/"],
      });

      // @ts-expect-error - typing issue in LangChain
      const result = await middleware.beforeAgent?.({});

      expect(result?.skillsMetadata).toHaveLength(1);
      expect(result?.skillsMetadata[0].allowedTools).toEqual([
        "read_file",
        "write_file",
        "grep",
      ]);
    });

    it("should skip skill with YAML parse error", async () => {
      const skillContent = `---
name: broken-yaml
description: [invalid yaml syntax: unclosed bracket
---

# Broken YAML Skill`;

      const mockBackend = createMockBackend({
        files: {
          "/skills/user/broken-yaml/SKILL.md": skillContent,
        },
        directories: {
          "/skills/user/": [{ name: "broken-yaml", type: "directory" }],
        },
      });

      const middleware = createSkillsMiddleware({
        backend: mockBackend,
        sources: ["/skills/user/"],
      });

      const consoleWarnSpy = vi
        .spyOn(console, "warn")
        .mockImplementation(() => {});

      // @ts-expect-error - typing issue in LangChain
      const result = await middleware.beforeAgent?.({});

      // Should skip the skill with YAML error
      expect(result?.skillsMetadata).toEqual([]);
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Invalid YAML"),
        expect.anything(),
      );

      consoleWarnSpy.mockRestore();
    });

    it("should normalize Unix paths without trailing slash", async () => {
      // Unix paths use forward slashes
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
        sources: ["/skills/user"], // No trailing slash
      });

      // @ts-expect-error - typing issue in LangChain
      const result = await middleware.beforeAgent?.({});

      // Should normalize path (adding trailing /) and load skill successfully
      expect(result?.skillsMetadata).toHaveLength(1);
      expect(result?.skillsMetadata[0].name).toBe("web-research");
      expect(result?.skillsMetadata[0].path).toBe(
        "/skills/user/web-research/SKILL.md",
      );
    });

    it("should handle Windows-style backslash paths", async () => {
      const mockBackend = createMockBackend({
        files: {
          "C:\\skills\\user\\web-research\\SKILL.md": VALID_SKILL_CONTENT,
        },
        directories: {
          "C:\\skills\\user\\": [{ name: "web-research", type: "directory" }],
        },
      });

      const middleware = createSkillsMiddleware({
        backend: mockBackend,
        sources: ["C:\\skills\\user"], // No trailing backslash
      });

      // @ts-expect-error - typing issue in LangChain
      const result = await middleware.beforeAgent?.({});

      // Should normalize path (adding trailing \) and load skill successfully
      expect(result?.skillsMetadata).toHaveLength(1);
      expect(result?.skillsMetadata[0].name).toBe("web-research");
      expect(result?.skillsMetadata[0].path).toBe(
        "C:\\skills\\user\\web-research\\SKILL.md",
      );
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

    it("should show priority indicator for last source", () => {
      const middleware = createSkillsMiddleware({
        backend: createMockBackend({ files: {}, directories: {} }),
        sources: ["/skills/user/", "/skills/project/"],
      });

      const mockHandler = vi.fn().mockReturnValue({ response: "ok" });
      const request: any = {
        systemPrompt: "Base prompt",
        state: { skillsMetadata: [] },
      };

      middleware.wrapModelCall!(request, mockHandler);

      const modifiedRequest = mockHandler.mock.calls[0][0];
      // Last source should have "higher priority" indicator
      expect(modifiedRequest.systemPrompt).toContain("(higher priority)");
      // Should show project source with priority
      expect(modifiedRequest.systemPrompt).toContain("Project Skills");
      expect(modifiedRequest.systemPrompt).toContain("/skills/project/");
    });

    it("should show allowed tools for skills that have them", () => {
      const middleware = createSkillsMiddleware({
        backend: createMockBackend({ files: {}, directories: {} }),
        sources: ["/skills/user/"],
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
              allowedTools: ["search_web", "fetch_url"],
            },
          ],
        },
      };

      middleware.wrapModelCall!(request, mockHandler);

      const modifiedRequest = mockHandler.mock.calls[0][0];
      expect(modifiedRequest.systemPrompt).toContain("Allowed tools:");
      expect(modifiedRequest.systemPrompt).toContain("search_web");
      expect(modifiedRequest.systemPrompt).toContain("fetch_url");
    });

    it("should not show allowed tools line if skill has no allowed tools", () => {
      const middleware = createSkillsMiddleware({
        backend: createMockBackend({ files: {}, directories: {} }),
        sources: ["/skills/user/"],
      });

      const mockHandler = vi.fn().mockReturnValue({ response: "ok" });
      const request: any = {
        systemPrompt: "Base prompt",
        state: {
          skillsMetadata: [
            {
              name: "basic-skill",
              description: "A basic skill",
              path: "/skills/user/basic-skill/SKILL.md",
              allowedTools: [],
            },
          ],
        },
      };

      middleware.wrapModelCall!(request, mockHandler);

      const modifiedRequest = mockHandler.mock.calls[0][0];
      // Should not have "Allowed tools:" line for skills without allowed tools
      const allowedToolsCount = (
        modifiedRequest.systemPrompt.match(/Allowed tools:/g) || []
      ).length;
      expect(allowedToolsCount).toBe(0);
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

    it("should restore skills from checkpoint and inject into prompt", async () => {
      const mockBackend = createMockBackend({
        files: {},
        directories: {},
      });

      const middleware = createSkillsMiddleware({
        backend: mockBackend,
        sources: ["/skills/user/"],
      });

      // Simulate checkpoint restore scenario
      const checkpointState = {
        skillsMetadata: [
          {
            name: "restored-skill",
            description: "Restored from checkpoint",
            path: "/skills/user/restored-skill/SKILL.md",
          },
        ],
      };

      // Step 1: beforeAgent should skip reload when skillsMetadata exists
      // @ts-expect-error - typing issue in LangChain
      const result = await middleware.beforeAgent?.(checkpointState);
      expect(result).toBeUndefined();

      // Step 2: wrapModelCall should use the restored skills from state
      const mockHandler = vi.fn().mockReturnValue({ response: "ok" });
      const request: any = {
        systemPrompt: "Base prompt",
        state: checkpointState,
      };

      middleware.wrapModelCall!(request, mockHandler);

      const modifiedRequest = mockHandler.mock.calls[0][0];
      expect(modifiedRequest.systemPrompt).toContain("restored-skill");
      expect(modifiedRequest.systemPrompt).toContain(
        "Restored from checkpoint",
      );
    });
  });
});

describe("skillsMetadataReducer", () => {
  // Helper to create a minimal valid skill metadata entry
  function createSkill(
    name: string,
    description = "A test skill",
  ): SkillMetadataEntry {
    return {
      name,
      description,
      path: `/skills/${name}/SKILL.md`,
    };
  }

  describe("edge cases", () => {
    it("should return empty array when both current and update are undefined", () => {
      const result = skillsMetadataReducer(undefined, undefined);
      expect(result).toEqual([]);
    });

    it("should return empty array when current is undefined and update is empty", () => {
      const result = skillsMetadataReducer(undefined, []);
      expect(result).toEqual([]);
    });

    it("should return current when update is undefined", () => {
      const current = [createSkill("skill-a")];
      const result = skillsMetadataReducer(current, undefined);
      expect(result).toEqual(current);
    });

    it("should return current when update is empty array", () => {
      const current = [createSkill("skill-a")];
      const result = skillsMetadataReducer(current, []);
      expect(result).toEqual(current);
    });

    it("should return update when current is undefined", () => {
      const update = [createSkill("skill-a")];
      const result = skillsMetadataReducer(undefined, update);
      expect(result).toEqual(update);
    });

    it("should return update when current is empty array", () => {
      const update = [createSkill("skill-a")];
      const result = skillsMetadataReducer([], update);
      expect(result).toEqual(update);
    });
  });

  describe("merging behavior", () => {
    it("should merge non-overlapping skills from current and update", () => {
      const current = [createSkill("skill-a")];
      const update = [createSkill("skill-b")];

      const result = skillsMetadataReducer(current, update);

      expect(result).toHaveLength(2);
      expect(result.map((s) => s.name).sort()).toEqual(["skill-a", "skill-b"]);
    });

    it("should override current skill with update when names match", () => {
      const current = [createSkill("skill-a", "Current description")];
      const update = [createSkill("skill-a", "Updated description")];

      const result = skillsMetadataReducer(current, update);

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe("skill-a");
      expect(result[0].description).toBe("Updated description");
    });

    it("should handle multiple overlapping skills (update wins)", () => {
      const current = [
        createSkill("skill-a", "Current A"),
        createSkill("skill-b", "Current B"),
        createSkill("skill-c", "Current C"),
      ];
      const update = [
        createSkill("skill-a", "Updated A"),
        createSkill("skill-c", "Updated C"),
      ];

      const result = skillsMetadataReducer(current, update);

      expect(result).toHaveLength(3);

      const skillA = result.find((s) => s.name === "skill-a");
      const skillB = result.find((s) => s.name === "skill-b");
      const skillC = result.find((s) => s.name === "skill-c");

      expect(skillA?.description).toBe("Updated A");
      expect(skillB?.description).toBe("Current B"); // Not updated
      expect(skillC?.description).toBe("Updated C");
    });

    it("should preserve order: current skills first, then new skills from update", () => {
      const current = [createSkill("skill-a"), createSkill("skill-b")];
      const update = [createSkill("skill-c"), createSkill("skill-d")];

      const result = skillsMetadataReducer(current, update);

      expect(result.map((s) => s.name)).toEqual([
        "skill-a",
        "skill-b",
        "skill-c",
        "skill-d",
      ]);
    });
  });

  describe("parallel subagent simulation", () => {
    it("should handle concurrent updates from multiple parallel subagents", () => {
      // Simulate: main agent has loaded skills, two subagents run in parallel
      const mainAgentSkills = [
        createSkill("shared-skill", "Main agent version"),
        createSkill("main-only", "Only in main"),
      ];

      // First subagent returns
      const subagent1Update = [
        createSkill("shared-skill", "Subagent 1 version"),
        createSkill("subagent1-skill", "From subagent 1"),
      ];

      // Second subagent returns
      const subagent2Update = [
        createSkill("shared-skill", "Subagent 2 version"),
        createSkill("subagent2-skill", "From subagent 2"),
      ];

      // Apply updates sequentially (as the reducer would be called)
      const afterSubagent1 = skillsMetadataReducer(
        mainAgentSkills,
        subagent1Update,
      );
      const afterSubagent2 = skillsMetadataReducer(
        afterSubagent1,
        subagent2Update,
      );

      expect(afterSubagent2).toHaveLength(4);

      const sharedSkill = afterSubagent2.find((s) => s.name === "shared-skill");
      expect(sharedSkill?.description).toBe("Subagent 2 version"); // Last update wins

      expect(afterSubagent2.map((s) => s.name).sort()).toEqual([
        "main-only",
        "shared-skill",
        "subagent1-skill",
        "subagent2-skill",
      ]);
    });

    it("should preserve all metadata fields when merging", () => {
      const current: SkillMetadataEntry[] = [
        {
          name: "full-skill",
          description: "Current version",
          path: "/skills/full-skill/SKILL.md",
          license: "MIT",
          compatibility: "node >= 18",
          metadata: { author: "original" },
          allowedTools: ["read_file"],
        },
      ];

      const update: SkillMetadataEntry[] = [
        {
          name: "full-skill",
          description: "Updated version",
          path: "/skills/full-skill/SKILL.md",
          license: "Apache-2.0",
          compatibility: "node >= 20",
          metadata: { author: "updated", version: "2.0" },
          allowedTools: ["read_file", "write_file"],
        },
      ];

      const result = skillsMetadataReducer(current, update);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual(update[0]); // Full replacement with update
    });
  });
});

/**
 * StateBackend integration tests.
 *
 * These tests verify that skills are properly loaded from state.files and
 * injected into the system prompt when using createDeepAgent with StateBackend.
 */
describe("StateBackend integration with createDeepAgent", () => {
  const VALID_SKILL_MD = `---
name: test-skill
description: A test skill for StateBackend integration
---

# Test Skill

Instructions for the test skill.
`;

  const ANOTHER_SKILL_MD = `---
name: another-skill
description: Another test skill
---

# Another Skill
`;

  /**
   * Helper to extract system prompt content from model invoke spy.
   * The system message can have content as string or array of content blocks.
   */
  function getSystemPromptFromSpy(
    invokeSpy: ReturnType<typeof vi.spyOn>,
  ): string {
    const lastCall = invokeSpy.mock.calls[invokeSpy.mock.calls.length - 1];
    const messages = lastCall?.[0] as BaseMessage[] | undefined;
    if (!messages) return "";
    const systemMessage = messages.find(SystemMessage.isInstance);
    if (!systemMessage) return "";

    return systemMessage.text;
  }

  it("should load skills from state.files and inject into system prompt", async () => {
    const invokeSpy = vi.spyOn(FakeListChatModel.prototype, "invoke");
    const model = new FakeListChatModel({ responses: ["Done"] });

    const checkpointer = new MemorySaver();
    const agent = createDeepAgent({
      model: model as any,
      skills: ["/skills/"],
      checkpointer,
    });

    await agent.invoke(
      {
        messages: [new HumanMessage("What skills are available?")],
        files: {
          "/skills/test-skill/SKILL.md": createFileData(VALID_SKILL_MD),
        },
      } as any,
      { configurable: { thread_id: `test-${Date.now()}` }, recursionLimit: 50 },
    );

    expect(invokeSpy).toHaveBeenCalled();
    const systemPrompt = getSystemPromptFromSpy(invokeSpy);

    // Verify skill was injected into system prompt
    expect(systemPrompt).toContain("test-skill");
    expect(systemPrompt).toContain("A test skill for StateBackend integration");
    expect(systemPrompt).toContain("/skills/test-skill/SKILL.md");
    invokeSpy.mockRestore();
  });

  it("should load multiple skills from state.files", async () => {
    const invokeSpy = vi.spyOn(FakeListChatModel.prototype, "invoke");
    const model = new FakeListChatModel({ responses: ["Done"] });

    const checkpointer = new MemorySaver();
    const agent = createDeepAgent({
      model: model as any,
      skills: ["/skills/"],
      checkpointer,
    });

    await agent.invoke(
      {
        messages: [new HumanMessage("List all skills")],
        files: {
          "/skills/test-skill/SKILL.md": createFileData(VALID_SKILL_MD),
          "/skills/another-skill/SKILL.md": createFileData(ANOTHER_SKILL_MD),
        },
      } as any,
      {
        configurable: { thread_id: `test-multi-${Date.now()}` },
        recursionLimit: 50,
      },
    );

    expect(invokeSpy).toHaveBeenCalled();
    const systemPrompt = getSystemPromptFromSpy(invokeSpy);

    // Verify both skills were injected
    expect(systemPrompt).toContain("test-skill");
    expect(systemPrompt).toContain("another-skill");
    expect(systemPrompt).toContain("A test skill for StateBackend integration");
    expect(systemPrompt).toContain("Another test skill");
    invokeSpy.mockRestore();
  });

  it("should show no skills message when state.files is empty", async () => {
    const invokeSpy = vi.spyOn(FakeListChatModel.prototype, "invoke");
    const model = new FakeListChatModel({ responses: ["Done"] });

    const checkpointer = new MemorySaver();
    const agent = createDeepAgent({
      model: model as any,
      skills: ["/skills/"],
      checkpointer,
    });

    await agent.invoke(
      {
        messages: [new HumanMessage("Hello")],
        files: {},
      } as any,
      {
        configurable: { thread_id: `test-empty-${Date.now()}` },
        recursionLimit: 50,
      },
    );

    expect(invokeSpy).toHaveBeenCalled();
    const systemPrompt = getSystemPromptFromSpy(invokeSpy);

    // Verify "no skills" message appears
    expect(systemPrompt).toContain("No skills available yet");
    expect(systemPrompt).toContain("/skills/");
    invokeSpy.mockRestore();
  });

  it("should load skills from multiple sources via StateBackend", async () => {
    const userSkillMd = `---
name: user-skill
description: User-level skill for personal workflows
---
# User Skill`;

    const projectSkillMd = `---
name: project-skill
description: Project-level skill for team collaboration
---
# Project Skill`;

    const invokeSpy = vi.spyOn(FakeListChatModel.prototype, "invoke");
    const model = new FakeListChatModel({ responses: ["Done"] });

    const checkpointer = new MemorySaver();
    const agent = createDeepAgent({
      model: model as any,
      skills: ["/skills/user/", "/skills/project/"],
      checkpointer,
    });

    await agent.invoke(
      {
        messages: [new HumanMessage("List skills")],
        files: {
          "/skills/user/user-skill/SKILL.md": createFileData(userSkillMd),
          "/skills/project/project-skill/SKILL.md":
            createFileData(projectSkillMd),
        },
      } as any,
      {
        configurable: { thread_id: `test-sources-${Date.now()}` },
        recursionLimit: 50,
      },
    );

    expect(invokeSpy).toHaveBeenCalled();
    const systemPrompt = getSystemPromptFromSpy(invokeSpy);

    // Verify both sources' skills are present
    expect(systemPrompt).toContain("user-skill");
    expect(systemPrompt).toContain("project-skill");
    expect(systemPrompt).toContain("User-level skill");
    expect(systemPrompt).toContain("Project-level skill");
    invokeSpy.mockRestore();
  });

  it("should include skill paths for progressive disclosure", async () => {
    const invokeSpy = vi.spyOn(FakeListChatModel.prototype, "invoke");
    const model = new FakeListChatModel({ responses: ["Done"] });

    const checkpointer = new MemorySaver();
    const agent = createDeepAgent({
      model: model as any,
      skills: ["/skills/"],
      checkpointer,
    });

    await agent.invoke(
      {
        messages: [new HumanMessage("What skills?")],
        files: {
          "/skills/test-skill/SKILL.md": createFileData(VALID_SKILL_MD),
        },
      } as any,
      {
        configurable: { thread_id: `test-paths-${Date.now()}` },
        recursionLimit: 50,
      },
    );

    expect(invokeSpy).toHaveBeenCalled();
    const systemPrompt = getSystemPromptFromSpy(invokeSpy);

    // Verify the full path is included for progressive disclosure
    expect(systemPrompt).toContain("/skills/test-skill/SKILL.md");
    // Verify progressive disclosure instructions are present
    expect(systemPrompt).toContain("Progressive Disclosure");
    invokeSpy.mockRestore();
  });

  it("should handle empty skills directory gracefully", async () => {
    const invokeSpy = vi.spyOn(FakeListChatModel.prototype, "invoke");
    const model = new FakeListChatModel({ responses: ["Done"] });

    const checkpointer = new MemorySaver();
    const agent = createDeepAgent({
      model: model as any,
      skills: ["/skills/empty/"],
      checkpointer,
    });

    // Should not throw even when no skills exist (empty files)
    await expect(
      agent.invoke(
        {
          messages: [new HumanMessage("Hello")],
          files: {},
        } as any,
        {
          configurable: { thread_id: `test-empty-graceful-${Date.now()}` },
          recursionLimit: 50,
        },
      ),
    ).resolves.toBeDefined();

    expect(invokeSpy).toHaveBeenCalled();
    const systemPrompt = getSystemPromptFromSpy(invokeSpy);

    // Should still have a system prompt with the "no skills" message
    expect(systemPrompt).toContain("No skills available yet");
    invokeSpy.mockRestore();
  });
});
