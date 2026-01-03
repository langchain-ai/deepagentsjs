import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { listSkills, parseSkillMetadata } from "./loader.js";

describe("Skill Loader Module", () => {
  let tempDir: string;
  let userSkillsDir: string;
  let projectSkillsDir: string;

  beforeEach(() => {
    // Create temporary directories for testing
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "deepagents-skills-test-"));
    userSkillsDir = path.join(tempDir, "user-skills");
    projectSkillsDir = path.join(tempDir, "project-skills");
    fs.mkdirSync(userSkillsDir, { recursive: true });
    fs.mkdirSync(projectSkillsDir, { recursive: true });
  });

  afterEach(() => {
    // Cleanup temp directory
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  /**
   * Helper to create a skill directory with SKILL.md
   */
  function createSkill(
    baseDir: string,
    skillName: string,
    frontmatter: Record<string, string>,
    body = "# Skill Instructions\n\nUse this skill when...",
  ): string {
    const skillDir = path.join(baseDir, skillName);
    fs.mkdirSync(skillDir, { recursive: true });

    const yamlContent = Object.entries(frontmatter)
      .map(([key, value]) => `${key}: ${value}`)
      .join("\n");

    const skillMd = `---\n${yamlContent}\n---\n\n${body}`;
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), skillMd);

    return skillDir;
  }

  describe("parseSkillMetadata", () => {
    it("should parse valid skill with frontmatter", () => {
      createSkill(userSkillsDir, "web-research", {
        name: "web-research",
        description: "Research the web for information",
      });

      const result = parseSkillMetadata(
        path.join(userSkillsDir, "web-research", "SKILL.md"),
        "user",
      );

      expect(result).not.toBeNull();
      expect(result!.name).toBe("web-research");
      expect(result!.description).toBe("Research the web for information");
      expect(result!.source).toBe("user");
      expect(result!.path).toContain(path.join("web-research", "SKILL.md"));
    });

    it("should return null for missing frontmatter", () => {
      const skillDir = path.join(userSkillsDir, "no-frontmatter");
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(
        path.join(skillDir, "SKILL.md"),
        "# No Frontmatter\n\nJust content",
      );

      const result = parseSkillMetadata(
        path.join(skillDir, "SKILL.md"),
        "user",
      );

      expect(result).toBeNull();
    });

    it("should return null when name is missing", () => {
      createSkill(userSkillsDir, "missing-name", {
        description: "A skill without a name",
      });

      const result = parseSkillMetadata(
        path.join(userSkillsDir, "missing-name", "SKILL.md"),
        "user",
      );

      expect(result).toBeNull();
    });

    it("should return null when description is missing", () => {
      createSkill(userSkillsDir, "missing-desc", {
        name: "missing-desc",
      });

      const result = parseSkillMetadata(
        path.join(userSkillsDir, "missing-desc", "SKILL.md"),
        "user",
      );

      expect(result).toBeNull();
    });

    it("should parse optional fields", () => {
      const skillDir = path.join(userSkillsDir, "full-skill");
      fs.mkdirSync(skillDir, { recursive: true });

      const skillMd = `---
name: full-skill
description: A skill with all fields
license: MIT
compatibility: Node.js 18+
allowed-tools: read_file write_file
---

# Full Skill
`;
      fs.writeFileSync(path.join(skillDir, "SKILL.md"), skillMd);

      const result = parseSkillMetadata(
        path.join(skillDir, "SKILL.md"),
        "project",
      );

      expect(result).not.toBeNull();
      expect(result!.license).toBe("MIT");
      expect(result!.compatibility).toBe("Node.js 18+");
      expect(result!.allowedTools).toBe("read_file write_file");
      expect(result!.source).toBe("project");
    });

    it("should truncate long descriptions", () => {
      const longDesc = "A".repeat(2000);
      createSkill(userSkillsDir, "long-desc", {
        name: "long-desc",
        description: longDesc,
      });

      const result = parseSkillMetadata(
        path.join(userSkillsDir, "long-desc", "SKILL.md"),
        "user",
      );

      expect(result).not.toBeNull();
      expect(result!.description.length).toBe(1024);
    });

    it("should warn but parse when name doesn't match directory", () => {
      createSkill(userSkillsDir, "my-skill", {
        name: "different-name",
        description: "Name doesn't match directory",
      });

      // Should still parse, just with a warning
      const result = parseSkillMetadata(
        path.join(userSkillsDir, "my-skill", "SKILL.md"),
        "user",
      );

      expect(result).not.toBeNull();
      expect(result!.name).toBe("different-name");
    });
  });

  describe("listSkills", () => {
    it("should return empty array for empty directory", () => {
      const result = listSkills({ userSkillsDir });
      expect(result).toEqual([]);
    });

    it("should return empty array for non-existent directory", () => {
      const result = listSkills({
        userSkillsDir: "/non/existent/path",
      });
      expect(result).toEqual([]);
    });

    it("should list skills from user directory", () => {
      createSkill(userSkillsDir, "skill-one", {
        name: "skill-one",
        description: "First skill",
      });
      createSkill(userSkillsDir, "skill-two", {
        name: "skill-two",
        description: "Second skill",
      });

      const result = listSkills({ userSkillsDir });

      expect(result).toHaveLength(2);
      expect(result.map((s) => s.name).sort()).toEqual([
        "skill-one",
        "skill-two",
      ]);
      expect(result.every((s) => s.source === "user")).toBe(true);
    });

    it("should list skills from project directory", () => {
      createSkill(projectSkillsDir, "project-skill", {
        name: "project-skill",
        description: "A project-specific skill",
      });

      const result = listSkills({ projectSkillsDir });

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe("project-skill");
      expect(result[0].source).toBe("project");
    });

    it("should merge user and project skills", () => {
      createSkill(userSkillsDir, "user-skill", {
        name: "user-skill",
        description: "User skill",
      });
      createSkill(projectSkillsDir, "project-skill", {
        name: "project-skill",
        description: "Project skill",
      });

      const result = listSkills({ userSkillsDir, projectSkillsDir });

      expect(result).toHaveLength(2);
      expect(result.find((s) => s.name === "user-skill")?.source).toBe("user");
      expect(result.find((s) => s.name === "project-skill")?.source).toBe(
        "project",
      );
    });

    it("should allow project skills to override user skills with same name", () => {
      createSkill(userSkillsDir, "shared-skill", {
        name: "shared-skill",
        description: "User version",
      });
      createSkill(projectSkillsDir, "shared-skill", {
        name: "shared-skill",
        description: "Project version",
      });

      const result = listSkills({ userSkillsDir, projectSkillsDir });

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe("shared-skill");
      expect(result[0].source).toBe("project");
      expect(result[0].description).toBe("Project version");
    });

    it("should skip directories without SKILL.md", () => {
      // Create valid skill
      createSkill(userSkillsDir, "valid-skill", {
        name: "valid-skill",
        description: "Has SKILL.md",
      });

      // Create directory without SKILL.md
      const invalidDir = path.join(userSkillsDir, "invalid-skill");
      fs.mkdirSync(invalidDir, { recursive: true });
      fs.writeFileSync(path.join(invalidDir, "README.md"), "# Not a skill");

      const result = listSkills({ userSkillsDir });

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe("valid-skill");
    });

    it("should skip skills with invalid frontmatter", () => {
      // Create valid skill
      createSkill(userSkillsDir, "valid-skill", {
        name: "valid-skill",
        description: "Valid skill",
      });

      // Create skill with invalid frontmatter
      const invalidDir = path.join(userSkillsDir, "invalid-skill");
      fs.mkdirSync(invalidDir, { recursive: true });
      fs.writeFileSync(
        path.join(invalidDir, "SKILL.md"),
        "---\ninvalid: yaml: format:\n---\n",
      );

      const result = listSkills({ userSkillsDir });

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe("valid-skill");
    });

    it("should skip non-directory entries", () => {
      createSkill(userSkillsDir, "valid-skill", {
        name: "valid-skill",
        description: "Valid skill",
      });

      // Create a file (not directory) in skills dir
      fs.writeFileSync(path.join(userSkillsDir, "not-a-dir.txt"), "content");

      const result = listSkills({ userSkillsDir });

      expect(result).toHaveLength(1);
    });

    it("should handle mixed valid and invalid skills", () => {
      // Valid skill
      createSkill(userSkillsDir, "valid-one", {
        name: "valid-one",
        description: "First valid",
      });

      // Invalid - no description
      createSkill(userSkillsDir, "invalid-one", {
        name: "invalid-one",
      });

      // Valid skill
      createSkill(userSkillsDir, "valid-two", {
        name: "valid-two",
        description: "Second valid",
      });

      const result = listSkills({ userSkillsDir });

      expect(result).toHaveLength(2);
      expect(result.map((s) => s.name).sort()).toEqual([
        "valid-one",
        "valid-two",
      ]);
    });

    it("should load user skills first then project skills", () => {
      createSkill(userSkillsDir, "alpha", {
        name: "alpha",
        description: "User alpha",
      });
      createSkill(projectSkillsDir, "beta", {
        name: "beta",
        description: "Project beta",
      });

      const result = listSkills({ userSkillsDir, projectSkillsDir });

      // Should contain both
      expect(result).toHaveLength(2);
    });
  });
});
