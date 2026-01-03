import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createSettings } from "../../src/config.js";
import { listSkills } from "../../src/skills/loader.js";
import { createSkillsMiddleware } from "../../src/middleware/skills.js";
import { createAgentMemoryMiddleware } from "../../src/middleware/agent-memory.js";

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

      // Step 3: Create settings and middleware
      const settings = createSettings({ startPath: projectDir });
      expect(settings.hasProject).toBe(true);

      const middleware = createSkillsMiddleware({
        skillsDir: path.join(tempDir, "user-skills"), // Empty user skills
        assistantId: "test-agent",
        projectSkillsDir: settings.getProjectSkillsDir()!,
      });

      // Step 4: Load skills via beforeAgent
      const stateUpdate = middleware.beforeAgent!({});
      expect(stateUpdate!.skillsMetadata).toHaveLength(1);
      expect(stateUpdate!.skillsMetadata[0].name).toBe("my-skill");
      expect(stateUpdate!.skillsMetadata[0].source).toBe("project");

      // Step 5: Verify skills are injected into system prompt
      let capturedPrompt = "";
      await middleware.wrapModelCall!(
        {
          systemPrompt: "Base prompt",
          state: stateUpdate,
        },
        (req: any) => {
          capturedPrompt = req.systemPrompt;
          return Promise.resolve({ messages: [] });
        },
      );

      expect(capturedPrompt).toContain("my-skill");
      expect(capturedPrompt).toContain("A test skill for integration testing");
      expect(capturedPrompt).toContain("Project Skills:");
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

      // Create both middleware
      const skillsMiddleware = createSkillsMiddleware({
        skillsDir: path.join(userDeepagentsDir, "test-agent", "skills"),
        assistantId: "test-agent",
        projectSkillsDir: mockSettings.getProjectSkillsDir(),
      });

      const memoryMiddleware = createAgentMemoryMiddleware({
        settings: mockSettings,
        assistantId: "test-agent",
      });

      // Run beforeAgent for both
      const skillsState = skillsMiddleware.beforeAgent!({});
      const memoryState = memoryMiddleware.beforeAgent!({});

      // Combine states
      const combinedState = { ...skillsState, ...memoryState };

      // Run wrapModelCall for both in sequence
      let finalPrompt = "";

      // First, memory middleware
      await memoryMiddleware.wrapModelCall!(
        {
          systemPrompt: "Base prompt",
          state: combinedState,
        },
        async (req: any) => {
          // Then, skills middleware
          await skillsMiddleware.wrapModelCall!(
            {
              systemPrompt: req.systemPrompt,
              state: combinedState,
            },
            (innerReq: any) => {
              finalPrompt = innerReq.systemPrompt;
              return Promise.resolve({ messages: [] });
            },
          );
          return { messages: [] };
        },
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
