import { describe, it, expect } from "vitest";
import { HumanMessage } from "@langchain/core/messages";
import { MemorySaver } from "@langchain/langgraph";
import { createDeepAgent } from "../agent.js";
import { SAMPLE_MODEL } from "../testing/utils.js";
import { createFileData } from "../backends/utils.js";

/**
 * Integration tests for SkillsMiddleware with StateBackend.
 *
 * These tests verify that the middleware can access files from state.files
 * when running through a full LangGraph agent via createDeepAgent.
 *
 * This tests the fix for the state schema issue where `files` was not declared
 * in SkillsStateSchema, causing LangGraph to filter it out before passing
 * state to beforeAgent.
 */
describe("SkillsMiddleware StateBackend Integration", () => {
  it.concurrent(
    "should load skills from state.files and inject into system prompt",
    { timeout: 90 * 1000 },
    async () => {
      const checkpointer = new MemorySaver();

      // createDeepAgent with skills option - the standard usage pattern
      const agent = createDeepAgent({
        model: SAMPLE_MODEL,
        skills: ["/skills/"],
        checkpointer,
      });

      const config = {
        configurable: {
          thread_id: `test-skills-${Date.now()}`,
        },
      };

      const response = await agent.invoke(
        {
          messages: [
            new HumanMessage(
              "Based on the skills system shown in your prompt, what is the name of the available skill? Just say the skill name, nothing else.",
            ),
          ],
          // Seed the StateBackend's in-state filesystem with a skill
          files: {
            "/skills/secret-decoder/SKILL.md": createFileData(
              `---
name: secret-decoder
description: Decodes secret messages using the ZEBRA protocol
---

# Secret Decoder Skill

Instructions for decoding secret messages.`,
            ),
          },
        } as any,
        { ...config, recursionLimit: 50 },
      );

      // The skill metadata should have been loaded and injected into the system prompt
      // and the model should be able to reference it
      const lastMessage = response.messages[response.messages.length - 1];
      const content = lastMessage.content.toString().toLowerCase();

      // The model should mention the skill name
      expect(content).toContain("secret-decoder");
    },
  );

  it.concurrent(
    "should load multiple skills from state.files",
    { timeout: 90 * 1000 },
    async () => {
      const checkpointer = new MemorySaver();

      const agent = createDeepAgent({
        model: SAMPLE_MODEL,
        skills: ["/skills/"],
        checkpointer,
      });

      const config = {
        configurable: {
          thread_id: `test-multi-skills-${Date.now()}`,
        },
      };

      const response = await agent.invoke(
        {
          messages: [
            new HumanMessage(
              "Based on the skills system shown in your prompt, list ALL available skill names. Just say the skill names separated by commas, nothing else.",
            ),
          ],
          files: {
            "/skills/alpha-skill/SKILL.md": createFileData(
              `---
name: alpha-skill
description: First test skill for integration testing
---

# Alpha Skill`,
            ),
            "/skills/beta-skill/SKILL.md": createFileData(
              `---
name: beta-skill
description: Second test skill for integration testing
---

# Beta Skill`,
            ),
          },
        } as any,
        { ...config, recursionLimit: 50 },
      );

      const lastMessage = response.messages[response.messages.length - 1];
      const content = lastMessage.content.toString().toLowerCase();

      // Both skills should be accessible
      expect(content).toContain("alpha-skill");
      expect(content).toContain("beta-skill");
    },
  );

  it.concurrent(
    "should load skills from multiple sources via StateBackend",
    { timeout: 90 * 1000 },
    async () => {
      const checkpointer = new MemorySaver();

      // Multiple skill sources - user and project levels
      const agent = createDeepAgent({
        model: SAMPLE_MODEL,
        skills: ["/skills/user/", "/skills/project/"],
        checkpointer,
      });

      const config = {
        configurable: {
          thread_id: `test-sources-${Date.now()}`,
        },
      };

      const response = await agent.invoke(
        {
          messages: [
            new HumanMessage(
              "Based on the skills system shown in your prompt, list ALL available skill names. Just say the skill names separated by commas, nothing else.",
            ),
          ],
          files: {
            "/skills/user/user-skill/SKILL.md": createFileData(
              `---
name: user-skill
description: User-level skill for personal workflows
---

# User Skill`,
            ),
            "/skills/project/project-skill/SKILL.md": createFileData(
              `---
name: project-skill
description: Project-level skill for team workflows
---

# Project Skill`,
            ),
          },
        } as any,
        { ...config, recursionLimit: 50 },
      );

      const lastMessage = response.messages[response.messages.length - 1];
      const content = lastMessage.content.toString().toLowerCase();

      // Both skills from different sources should be loaded
      expect(content).toContain("user-skill");
      expect(content).toContain("project-skill");
    },
  );

  it.concurrent(
    "should handle empty skills directory gracefully",
    { timeout: 90 * 1000 },
    async () => {
      const checkpointer = new MemorySaver();

      const agent = createDeepAgent({
        model: SAMPLE_MODEL,
        skills: ["/skills/empty/"],
        checkpointer,
      });

      const config = {
        configurable: {
          thread_id: `test-empty-${Date.now()}`,
        },
      };

      // Should not throw even when no skills exist
      const response = await agent.invoke(
        {
          messages: [new HumanMessage("Say hello in one word.")],
          files: {},
        } as any,
        { ...config, recursionLimit: 50 },
      );

      const lastMessage = response.messages[response.messages.length - 1];
      expect(lastMessage.content).toBeDefined();
    },
  );

  it.concurrent(
    "should include skill descriptions in system prompt",
    { timeout: 90 * 1000 },
    async () => {
      const checkpointer = new MemorySaver();

      const agent = createDeepAgent({
        model: SAMPLE_MODEL,
        skills: ["/skills/"],
        checkpointer,
      });

      const config = {
        configurable: {
          thread_id: `test-desc-${Date.now()}`,
        },
      };

      const response = await agent.invoke(
        {
          messages: [
            new HumanMessage(
              "Based on your skills system, what does the 'quantum-analyzer' skill do? Answer with just the description, nothing else.",
            ),
          ],
          files: {
            "/skills/quantum-analyzer/SKILL.md": createFileData(
              `---
name: quantum-analyzer
description: Analyzes quantum entanglement patterns in data streams
---

# Quantum Analyzer

Advanced quantum analysis tool.`,
            ),
          },
        } as any,
        { ...config, recursionLimit: 50 },
      );

      const lastMessage = response.messages[response.messages.length - 1];
      const content = lastMessage.content.toString().toLowerCase();

      // The description should be visible to the model
      expect(content).toContain("quantum");
      expect(content).toContain("entanglement");
    },
  );
});
