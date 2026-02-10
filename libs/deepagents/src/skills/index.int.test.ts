import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { SystemMessage } from "@langchain/core/messages";
import { createSettings } from "../config.js";
import { listSkills } from "./loader.js";
import { createSkillsMiddleware } from "../middleware/skills.js";
import { createAgentMemoryMiddleware } from "../middleware/agent-memory.js";
import { FilesystemBackend } from "../backends/filesystem.js";

describe("Skills Integration Tests", () => {
  let tempDir: string;
  let projectDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "deepagents-skills-int-"));
    projectDir = path.join(tempDir, "project");

    // Create project structure
    fs.mkdirSync(path.join(projectDir, ".git"), { recursive: true });
    fs.mkdirSync(path.join(projectDir, ".deepagents", "skills"), {
      recursive: true,
    });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe("Full Skills Workflow", () => {
    it("should create skill, load via middleware, and inject into prompt", async () => {
      // Step 1: Create a skill directory
      const skillDir = path.join(
        projectDir,
        ".deepagents",
        "skills",
        "my-skill",
      );
      fs.mkdirSync(skillDir, { recursive: true });

      // Step 2: Add SKILL.md with valid frontmatter
      const skillContent = `---
name: my-skill
description: A test skill for integration testing
---

# My Skill

## Instructions

Use this skill when the user asks about integration testing.
`;
      fs.writeFileSync(path.join(skillDir, "SKILL.md"), skillContent);

      // Step 3: Create settings and middleware with new backend-agnostic API
      const settings = createSettings({ startPath: projectDir });
      expect(settings.hasProject).toBe(true);

      const projectSkillsDir = settings.getProjectSkillsDir()!;
      const userSkillsDir = path.join(tempDir, "user-skills");
      fs.mkdirSync(userSkillsDir, { recursive: true });

      const middleware = createSkillsMiddleware({
        backend: new FilesystemBackend({ rootDir: "/" }),
        sources: [userSkillsDir, projectSkillsDir],
      });

      // Step 4: Load skills via beforeAgent (now async)
      // @ts-expect-error - typing issue in LangChain
      const stateUpdate = await middleware.beforeAgent?.({});
      expect(stateUpdate!.skillsMetadata).toHaveLength(1);
      expect(stateUpdate!.skillsMetadata[0].name).toBe("my-skill");

      // Step 5: Verify skills are injected into system prompt
      let capturedMessage: SystemMessage | undefined;
      const mockHandler = (req: any) => {
        capturedMessage = req.systemMessage;
        return { response: "ok" };
      };
      middleware.wrapModelCall!(
        {
          systemMessage: new SystemMessage("Base prompt"),
          state: stateUpdate,
        } as any,
        mockHandler as any,
      );

      const capturedPrompt = capturedMessage!.text;
      expect(capturedPrompt).toContain("my-skill");
      expect(capturedPrompt).toContain("A test skill for integration testing");
      // Check for the new format with priority indicator
      expect(capturedPrompt).toContain("(higher priority)");
    });

    it("should allow project skill to override user skill with same name", async () => {
      // Create user skills directory
      const userSkillsDir = path.join(tempDir, "user-skills");
      fs.mkdirSync(path.join(userSkillsDir, "shared-skill"), {
        recursive: true,
      });

      // Create user skill
      const userSkillContent = `---
name: shared-skill
description: User version of shared skill
---

# User Version
`;
      fs.writeFileSync(
        path.join(userSkillsDir, "shared-skill", "SKILL.md"),
        userSkillContent,
      );

      // Create project skill with same name
      const projectSkillDir = path.join(
        projectDir,
        ".deepagents",
        "skills",
        "shared-skill",
      );
      fs.mkdirSync(projectSkillDir, { recursive: true });

      const projectSkillContent = `---
name: shared-skill
description: Project version of shared skill
---

# Project Version
`;
      fs.writeFileSync(
        path.join(projectSkillDir, "SKILL.md"),
        projectSkillContent,
      );

      // Load skills
      const skills = listSkills({
        userSkillsDir,
        projectSkillsDir: path.join(projectDir, ".deepagents", "skills"),
      });

      expect(skills).toHaveLength(1);
      expect(skills[0].name).toBe("shared-skill");
      expect(skills[0].source).toBe("project");
      expect(skills[0].description).toBe("Project version of shared skill");
    });
  });

  describe("Skills and Memory Middleware Together", () => {
    it("should work together without conflicts", async () => {
      // Create skill
      const skillDir = path.join(
        projectDir,
        ".deepagents",
        "skills",
        "test-skill",
      );
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(
        path.join(skillDir, "SKILL.md"),
        `---
name: test-skill
description: Test skill
---

# Test Skill
`,
      );

      // Create project memory
      fs.writeFileSync(
        path.join(projectDir, ".deepagents", "agent.md"),
        "# Project Memory\n\nTest project memory content.",
      );

      // Create settings pointing to temp dir for user files
      const userDeepagentsDir = path.join(tempDir, ".deepagents");
      const userAgentDir = path.join(userDeepagentsDir, "test-agent");
      fs.mkdirSync(userAgentDir, { recursive: true });
      fs.writeFileSync(
        path.join(userAgentDir, "agent.md"),
        "# User Memory\n\nTest user memory content.",
      );

      // Create mock settings
      const mockSettings = {
        projectRoot: projectDir,
        userDeepagentsDir,
        hasProject: true,
        getAgentDir: (name: string) => path.join(userDeepagentsDir, name),
        ensureAgentDir: (name: string) => {
          const dir = path.join(userDeepagentsDir, name);
          fs.mkdirSync(dir, { recursive: true });
          return dir;
        },
        getUserAgentMdPath: (name: string) =>
          path.join(userDeepagentsDir, name, "agent.md"),
        getProjectAgentMdPath: () =>
          path.join(projectDir, ".deepagents", "agent.md"),
        getUserSkillsDir: (name: string) =>
          path.join(userDeepagentsDir, name, "skills"),
        ensureUserSkillsDir: (name: string) => {
          const dir = path.join(userDeepagentsDir, name, "skills");
          fs.mkdirSync(dir, { recursive: true });
          return dir;
        },
        getProjectSkillsDir: () =>
          path.join(projectDir, ".deepagents", "skills"),
        ensureProjectSkillsDir: () =>
          path.join(projectDir, ".deepagents", "skills"),
        ensureProjectDeepagentsDir: () => path.join(projectDir, ".deepagents"),
      };

      // Create user skills directory
      const userSkillsDir = path.join(
        userDeepagentsDir,
        "test-agent",
        "skills",
      );
      fs.mkdirSync(userSkillsDir, { recursive: true });

      // Create both middleware using new backend-agnostic API
      const skillsMiddleware = createSkillsMiddleware({
        backend: new FilesystemBackend({ rootDir: "/" }),
        sources: [userSkillsDir, mockSettings.getProjectSkillsDir()],
      });

      const memoryMiddleware = createAgentMemoryMiddleware({
        settings: mockSettings,
        assistantId: "test-agent",
      });

      // Run beforeAgent for both (skills is now async)
      // @ts-expect-error - typing issue in LangChain
      const skillsState = await skillsMiddleware.beforeAgent?.({});
      // @ts-expect-error - typing issue in LangChain
      const memoryState = memoryMiddleware.beforeAgent?.({});

      // Combine states
      const combinedState = { ...skillsState, ...memoryState };

      // Run wrapModelCall for both in sequence
      let finalPrompt = "";

      // First, memory middleware (uses systemPrompt string API)
      memoryMiddleware.wrapModelCall!(
        {
          systemPrompt: "Base prompt",
          state: combinedState,
        } as any,
        ((req: any) => {
          // Then, skills middleware (uses systemMessage API)
          // Bridge: wrap memory middleware's string output as SystemMessage
          skillsMiddleware.wrapModelCall!(
            {
              systemMessage: new SystemMessage(req.systemPrompt),
              state: combinedState,
            } as any,
            ((innerReq: any) => {
              finalPrompt = innerReq.systemMessage.text;
              return { response: "ok" };
            }) as any,
          );
          return { response: "ok" };
        }) as any,
      );

      // Verify both are present
      expect(finalPrompt).toContain("Base prompt");
      expect(finalPrompt).toContain("test-skill");
      expect(finalPrompt).toContain("Test user memory content");
      expect(finalPrompt).toContain("Test project memory content");
      expect(finalPrompt).toContain("Skills System");
      expect(finalPrompt).toContain("Long-term Memory");
    });
  });

  describe("Example Skills Loading", () => {
    it("should load example skills from examples directory", () => {
      const examplesDir = path.join(process.cwd(), "examples", "skills");
      const skills = listSkills({ projectSkillsDir: examplesDir });

      // Should find the example skills we created
      const skillNames = skills.map((s) => s.name);

      if (skillNames.length > 0) {
        // Check that example skills are valid
        for (const skill of skills) {
          expect(skill.name).toBeTruthy();
          expect(skill.description).toBeTruthy();
          expect(skill.path).toContain("SKILL.md");
        }
      }
    });
  });
});
