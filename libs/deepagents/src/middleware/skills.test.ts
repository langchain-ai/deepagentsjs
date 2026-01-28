import { describe, it, expect, vi } from "vitest";
import {
  createSkillsMiddleware,
  skillsMetadataReducer,
  type SkillMetadataEntry,
} from "./skills.js";
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
