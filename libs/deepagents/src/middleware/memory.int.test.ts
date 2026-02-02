import { describe, it, expect } from "vitest";
import { HumanMessage } from "@langchain/core/messages";
import { createDeepAgent } from "../agent.js";
import { SAMPLE_MODEL } from "../testing/utils.js";

/**
 * Integration tests for MemoryMiddleware with StateBackend.
 *
 * These tests verify that the middleware can access files from state.files
 * when running through a full LangGraph agent via createDeepAgent.
 *
 * This tests the fix for the state schema issue where `files` was not declared
 * in MemoryStateSchema, causing LangGraph to filter it out before passing
 * state to beforeAgent.
 */
describe("MemoryMiddleware StateBackend Integration", () => {
  it.concurrent(
    "should load memory from state.files and inject into system prompt",
    { timeout: 90 * 1000 },
    async () => {
      // createDeepAgent with memory option - the standard usage pattern
      const agent = createDeepAgent({
        model: SAMPLE_MODEL,
        memory: ["/AGENTS.md"],
      });

      const response = await agent.invoke(
        {
          messages: [
            new HumanMessage(
              "Based on your agent memory shown above, what is the secret code? Just say the code, nothing else.",
            ),
          ],
          // Seed the StateBackend's in-state filesystem
          files: {
            "/AGENTS.md": {
              content: [
                "# My Memory",
                "",
                "Remember: The secret code is ALPHA123.",
              ],
              created_at: "2024-01-01T00:00:00Z",
              modified_at: "2024-01-01T00:00:00Z",
            },
          },
        } as any,
        { recursionLimit: 50 },
      );

      // The memory content should have been injected into the system prompt
      // and the model should be able to reference it
      const lastMessage = response.messages[response.messages.length - 1];
      const content = lastMessage.content.toString().toLowerCase();

      // The model should mention the secret code from the memory file
      expect(content).toContain("alpha123");
    },
  );

  it.concurrent(
    "should load multiple memory files from state.files",
    { timeout: 90 * 1000 },
    async () => {
      const agent = createDeepAgent({
        model: SAMPLE_MODEL,
        memory: ["/user/AGENTS.md", "/project/AGENTS.md"],
      });

      const response = await agent.invoke(
        {
          messages: [
            new HumanMessage(
              "Based on your agent memory shown above, what are the two code words? Just say the two words, nothing else.",
            ),
          ],
          files: {
            "/user/AGENTS.md": {
              content: ["# User Memory", "", "First code word: BANANA"],
              created_at: "2024-01-01T00:00:00Z",
              modified_at: "2024-01-01T00:00:00Z",
            },
            "/project/AGENTS.md": {
              content: ["# Project Memory", "", "Second code word: CHERRY"],
              created_at: "2024-01-01T00:00:00Z",
              modified_at: "2024-01-01T00:00:00Z",
            },
          },
        } as any,
        { recursionLimit: 50 },
      );

      const lastMessage = response.messages[response.messages.length - 1];
      const content = lastMessage.content.toString().toLowerCase();

      // Both code words should be accessible from memory
      expect(content).toContain("banana");
      expect(content).toContain("cherry");
    },
  );

  it.concurrent(
    "should handle missing memory files gracefully",
    { timeout: 90 * 1000 },
    async () => {
      const agent = createDeepAgent({
        model: SAMPLE_MODEL,
        memory: ["/missing/AGENTS.md"],
      });

      // Should not throw even when memory file doesn't exist
      const response = await agent.invoke(
        {
          messages: [new HumanMessage("Say hello in one word.")],
          files: {},
        } as any,
        { recursionLimit: 50 },
      );

      const lastMessage = response.messages[response.messages.length - 1];
      expect(lastMessage.content).toBeDefined();
    },
  );
});
