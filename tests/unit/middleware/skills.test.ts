import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createSkillsMiddleware } from "../../../src/middleware/skills.js";

describe("Skills Middleware", () => {
  let tempDir: string;
  let userSkillsDir: string;
  let projectSkillsDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "deepagents-skills-mw-test-"),
    );
    userSkillsDir = path.join(tempDir, "user-skills");
    projectSkillsDir = path.join(tempDir, "project-skills");
    fs.mkdirSync(userSkillsDir, { recursive: true });
    fs.mkdirSync(projectSkillsDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function createSkill(
    baseDir: string,
    skillName: string,
    description: string,
  ): void {
    const skillDir = path.join(baseDir, skillName);
    fs.mkdirSync(skillDir, { recursive: true });
    const content = `---
name: ${skillName}
description: ${description}
---

# ${skillName}

Instructions for using this skill.
`;
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), content);
  }

  describe("createSkillsMiddleware", () => {
    it("should create middleware with correct name", () => {
      const middleware = createSkillsMiddleware({
        skillsDir: userSkillsDir,
        assistantId: "test-agent",
      });

      expect(middleware.name).toBe("SkillsMiddleware");
    });

    it("should have beforeAgent and wrapModelCall hooks", () => {
      const middleware = createSkillsMiddleware({
        skillsDir: userSkillsDir,
        assistantId: "test-agent",
      });

      expect(middleware.beforeAgent).toBeDefined();
      expect(middleware.wrapModelCall).toBeDefined();
    });
  });

  describe("beforeAgent hook", () => {
    it("should load skills metadata into state", () => {
      createSkill(userSkillsDir, "web-research", "Research the web");
      createSkill(userSkillsDir, "code-review", "Review code quality");

      const middleware = createSkillsMiddleware({
        skillsDir: userSkillsDir,
        assistantId: "test-agent",
      });

      const result = middleware.beforeAgent!({});

      expect(result).toBeDefined();
      expect(result!.skillsMetadata).toHaveLength(2);
      expect(result!.skillsMetadata.map((s: any) => s.name).sort()).toEqual([
        "code-review",
        "web-research",
      ]);
    });

    it("should load both user and project skills", () => {
      createSkill(userSkillsDir, "user-skill", "User skill");
      createSkill(projectSkillsDir, "project-skill", "Project skill");

      const middleware = createSkillsMiddleware({
        skillsDir: userSkillsDir,
        assistantId: "test-agent",
        projectSkillsDir,
      });

      const result = middleware.beforeAgent!({});

      expect(result!.skillsMetadata).toHaveLength(2);
      expect(
        result!.skillsMetadata.find((s: any) => s.name === "user-skill")
          ?.source,
      ).toBe("user");
      expect(
        result!.skillsMetadata.find((s: any) => s.name === "project-skill")
          ?.source,
      ).toBe("project");
    });

    it("should return empty array when no skills", () => {
      const middleware = createSkillsMiddleware({
        skillsDir: userSkillsDir,
        assistantId: "test-agent",
      });

      const result = middleware.beforeAgent!({});

      expect(result!.skillsMetadata).toEqual([]);
    });
  });

  describe("wrapModelCall hook", () => {
    it("should inject skills documentation into system prompt", async () => {
      createSkill(userSkillsDir, "web-research", "Research the web");

      const middleware = createSkillsMiddleware({
        skillsDir: userSkillsDir,
        assistantId: "test-agent",
      });

      // Load skills first
      const stateUpdate = middleware.beforeAgent!({});

      let capturedRequest: any;
      const handler = vi.fn((request: any) => {
        capturedRequest = request;
        return Promise.resolve({ messages: [] });
      });

      await middleware.wrapModelCall!(
        {
          systemPrompt: "Base prompt",
          state: stateUpdate,
        },
        handler,
      );

      expect(capturedRequest.systemPrompt).toContain("Skills System");
      expect(capturedRequest.systemPrompt).toContain("web-research");
      expect(capturedRequest.systemPrompt).toContain("Research the web");
    });

    it("should format skills locations correctly", async () => {
      const middleware = createSkillsMiddleware({
        skillsDir: userSkillsDir,
        assistantId: "my-agent",
        projectSkillsDir,
      });

      const stateUpdate = middleware.beforeAgent!({});

      let capturedRequest: any;
      const handler = vi.fn((request: any) => {
        capturedRequest = request;
        return Promise.resolve({ messages: [] });
      });

      await middleware.wrapModelCall!(
        {
          systemPrompt: "",
          state: stateUpdate,
        },
        handler,
      );

      expect(capturedRequest.systemPrompt).toContain(
        "~/.deepagents/my-agent/skills",
      );
      expect(capturedRequest.systemPrompt).toContain(projectSkillsDir);
    });

    it("should group skills by source in output", async () => {
      createSkill(userSkillsDir, "user-skill", "A user skill");
      createSkill(projectSkillsDir, "project-skill", "A project skill");

      const middleware = createSkillsMiddleware({
        skillsDir: userSkillsDir,
        assistantId: "test-agent",
        projectSkillsDir,
      });

      const stateUpdate = middleware.beforeAgent!({});

      let capturedRequest: any;
      const handler = vi.fn((request: any) => {
        capturedRequest = request;
        return Promise.resolve({ messages: [] });
      });

      await middleware.wrapModelCall!(
        {
          systemPrompt: "",
          state: stateUpdate,
        },
        handler,
      );

      expect(capturedRequest.systemPrompt).toContain("User Skills:");
      expect(capturedRequest.systemPrompt).toContain("Project Skills:");
    });

    it("should append to existing system prompt", async () => {
      const middleware = createSkillsMiddleware({
        skillsDir: userSkillsDir,
        assistantId: "test-agent",
      });

      const stateUpdate = middleware.beforeAgent!({});

      let capturedRequest: any;
      const handler = vi.fn((request: any) => {
        capturedRequest = request;
        return Promise.resolve({ messages: [] });
      });

      await middleware.wrapModelCall!(
        {
          systemPrompt: "You are a helpful assistant.",
          state: stateUpdate,
        },
        handler,
      );

      expect(capturedRequest.systemPrompt).toContain(
        "You are a helpful assistant.",
      );
      expect(capturedRequest.systemPrompt).toContain("Skills System");
    });

    it("should show message when no skills available", async () => {
      const middleware = createSkillsMiddleware({
        skillsDir: userSkillsDir,
        assistantId: "test-agent",
      });

      const stateUpdate = middleware.beforeAgent!({});

      let capturedRequest: any;
      const handler = vi.fn((request: any) => {
        capturedRequest = request;
        return Promise.resolve({ messages: [] });
      });

      await middleware.wrapModelCall!(
        {
          systemPrompt: "",
          state: stateUpdate,
        },
        handler,
      );

      expect(capturedRequest.systemPrompt).toContain("No skills available yet");
    });
  });
});
