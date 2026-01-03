import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createSettings, findProjectRoot, type Settings } from "./config.js";

describe("Config Module", () => {
  let tempDir: string;
  let originalCwd: () => string;

  beforeEach(() => {
    // Create a temporary directory for testing
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "deepagents-test-"));
    originalCwd = process.cwd;
  });

  afterEach(() => {
    // Cleanup temp directory
    fs.rmSync(tempDir, { recursive: true, force: true });
    process.cwd = originalCwd;
  });

  describe("findProjectRoot", () => {
    it("should find .git directory", () => {
      // Create a .git directory
      const gitDir = path.join(tempDir, ".git");
      fs.mkdirSync(gitDir);

      const result = findProjectRoot(tempDir);
      expect(result).toBe(tempDir);
    });

    it("should find .git directory in parent", () => {
      // Create a .git directory in root
      const gitDir = path.join(tempDir, ".git");
      fs.mkdirSync(gitDir);

      // Create a nested directory
      const nestedDir = path.join(tempDir, "nested", "deep");
      fs.mkdirSync(nestedDir, { recursive: true });

      const result = findProjectRoot(nestedDir);
      expect(result).toBe(tempDir);
    });

    it("should return null when no .git found", () => {
      // No .git directory
      const result = findProjectRoot(tempDir);
      expect(result).toBeNull();
    });

    it("should use cwd when startPath is not provided", () => {
      // Create .git in cwd
      const gitDir = path.join(tempDir, ".git");
      fs.mkdirSync(gitDir);

      // Mock process.cwd
      process.cwd = () => tempDir;

      const result = findProjectRoot();
      expect(result).toBe(tempDir);
    });
  });

  describe("createSettings", () => {
    it("should return correct paths", () => {
      const settings = createSettings({ startPath: tempDir });

      expect(settings.userDeepagentsDir).toBe(
        path.join(os.homedir(), ".deepagents"),
      );
      expect(settings.projectRoot).toBeNull();
      expect(settings.hasProject).toBe(false);
    });

    it("should detect project root when .git exists", () => {
      const gitDir = path.join(tempDir, ".git");
      fs.mkdirSync(gitDir);

      const settings = createSettings({ startPath: tempDir });

      expect(settings.projectRoot).toBe(tempDir);
      expect(settings.hasProject).toBe(true);
    });

    describe("getAgentDir", () => {
      let settings: Settings;

      beforeEach(() => {
        settings = createSettings({ startPath: tempDir });
      });

      it("should return correct path for valid agent name", () => {
        const result = settings.getAgentDir("my-agent");
        expect(result).toBe(path.join(os.homedir(), ".deepagents", "my-agent"));
      });

      it("should accept alphanumeric names", () => {
        const result = settings.getAgentDir("Agent123");
        expect(result).toBe(path.join(os.homedir(), ".deepagents", "Agent123"));
      });

      it("should accept names with hyphens and underscores", () => {
        const result = settings.getAgentDir("my_agent-name");
        expect(result).toBe(
          path.join(os.homedir(), ".deepagents", "my_agent-name"),
        );
      });

      it("should accept names with spaces", () => {
        const result = settings.getAgentDir("My Agent");
        expect(result).toBe(path.join(os.homedir(), ".deepagents", "My Agent"));
      });

      it("should throw for invalid names with special characters", () => {
        expect(() => settings.getAgentDir("agent@name")).toThrow(
          /Invalid agent name/,
        );
      });

      it("should throw for empty name", () => {
        expect(() => settings.getAgentDir("")).toThrow(/Invalid agent name/);
      });

      it("should throw for whitespace-only name", () => {
        expect(() => settings.getAgentDir("   ")).toThrow(/Invalid agent name/);
      });
    });

    describe("ensureAgentDir", () => {
      it("should create directory if not exists", () => {
        const settings = createSettings({ startPath: tempDir });
        const agentName = "test-agent";
        const result = settings.ensureAgentDir(agentName);

        // Should end with the agent path
        expect(result).toContain(".deepagents");
        expect(result).toContain(agentName);
        expect(fs.existsSync(result)).toBe(true);
      });

      it("should return existing directory", () => {
        const settings = createSettings({ startPath: tempDir });
        const agentName = "test-agent";

        // Create directory first time
        const firstResult = settings.ensureAgentDir(agentName);
        expect(fs.existsSync(firstResult)).toBe(true);

        // Call again - should return the same path
        const secondResult = settings.ensureAgentDir(agentName);
        expect(secondResult).toBe(firstResult);
      });
    });

    describe("getUserAgentMdPath", () => {
      it("should return correct path", () => {
        const settings = createSettings({ startPath: tempDir });
        const result = settings.getUserAgentMdPath("my-agent");
        expect(result).toBe(
          path.join(os.homedir(), ".deepagents", "my-agent", "agent.md"),
        );
      });
    });

    describe("getProjectAgentMdPath", () => {
      it("should return null when not in project", () => {
        const settings = createSettings({ startPath: tempDir });
        expect(settings.getProjectAgentMdPath()).toBeNull();
      });

      it("should return correct path when in project", () => {
        const gitDir = path.join(tempDir, ".git");
        fs.mkdirSync(gitDir);

        const settings = createSettings({ startPath: tempDir });
        const result = settings.getProjectAgentMdPath();
        expect(result).toBe(path.join(tempDir, ".deepagents", "agent.md"));
      });
    });

    describe("getUserSkillsDir", () => {
      it("should return correct path", () => {
        const settings = createSettings({ startPath: tempDir });
        const result = settings.getUserSkillsDir("my-agent");
        expect(result).toBe(
          path.join(os.homedir(), ".deepagents", "my-agent", "skills"),
        );
      });
    });

    describe("ensureUserSkillsDir", () => {
      it("should create skills directory", () => {
        const settings = createSettings({ startPath: tempDir });
        const result = settings.ensureUserSkillsDir("my-agent");

        // Should end with skills path
        expect(result).toContain(".deepagents");
        expect(result).toContain("my-agent");
        expect(result).toContain("skills");
        expect(fs.existsSync(result)).toBe(true);
      });
    });

    describe("getProjectSkillsDir", () => {
      it("should return null when not in project", () => {
        const settings = createSettings({ startPath: tempDir });
        expect(settings.getProjectSkillsDir()).toBeNull();
      });

      it("should return correct path when in project", () => {
        const gitDir = path.join(tempDir, ".git");
        fs.mkdirSync(gitDir);

        const settings = createSettings({ startPath: tempDir });
        const result = settings.getProjectSkillsDir();
        expect(result).toBe(path.join(tempDir, ".deepagents", "skills"));
      });
    });

    describe("ensureProjectSkillsDir", () => {
      it("should return null when not in project", () => {
        const settings = createSettings({ startPath: tempDir });
        expect(settings.ensureProjectSkillsDir()).toBeNull();
      });

      it("should create directory when in project", () => {
        const gitDir = path.join(tempDir, ".git");
        fs.mkdirSync(gitDir);

        const settings = createSettings({ startPath: tempDir });
        const result = settings.ensureProjectSkillsDir();
        expect(result).toBe(path.join(tempDir, ".deepagents", "skills"));
        expect(fs.existsSync(result!)).toBe(true);
      });
    });

    describe("ensureProjectDeepagentsDir", () => {
      it("should return null when not in project", () => {
        const settings = createSettings({ startPath: tempDir });
        expect(settings.ensureProjectDeepagentsDir()).toBeNull();
      });

      it("should create directory when in project", () => {
        const gitDir = path.join(tempDir, ".git");
        fs.mkdirSync(gitDir);

        const settings = createSettings({ startPath: tempDir });
        const result = settings.ensureProjectDeepagentsDir();
        expect(result).toBe(path.join(tempDir, ".deepagents"));
        expect(fs.existsSync(result!)).toBe(true);
      });
    });
  });
});
