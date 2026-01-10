/**
 * Integration test for instanceof AIMessageChunk with Ollama provider.
 *
 * This test verifies that the fix for issue #64 works correctly:
 * - AIMessageChunk instances from Ollama streaming should pass `instanceof AIMessageChunk`
 * - This was previously failing because of duplicate @langchain/core module instances
 *
 * Prerequisites:
 * - Ollama must be running locally (`ollama serve`)
 * - A model must be available (e.g., `ollama pull tinyllama`)
 */

import { describe, it, expect } from "vitest";
import { ChatOllama } from "@langchain/ollama";
import { AIMessageChunk } from "@langchain/core/messages";

describe("Ollama instanceof AIMessageChunk", () => {
  it.concurrent(
    "should return true for instanceof AIMessageChunk when streaming",
    { timeout: 60_000 },
    async () => {
      const model = new ChatOllama({
        model: "tinyllama",
        baseUrl: "http://localhost:11434",
      });

      const chunks: AIMessageChunk[] = [];
      let instanceofPassCount = 0;
      let isInstancePassCount = 0;

      // Stream a simple response
      const stream = await model.stream("Say 'hello' in one word.");

      for await (const chunk of stream) {
        chunks.push(chunk);

        // Test both methods
        if (chunk instanceof AIMessageChunk) {
          instanceofPassCount++;
        }
        if (AIMessageChunk.isInstance(chunk)) {
          isInstancePassCount++;
        }

        // Debug info available in verbose mode:
        // content, instanceofPass, isInstancePass, constructorName
      }

      // We should have received at least one chunk
      expect(chunks.length).toBeGreaterThan(0);

      // All chunks should pass AIMessageChunk.isInstance() - this always works
      expect(isInstancePassCount).toBe(chunks.length);

      // After the fix: All chunks should ALSO pass instanceof AIMessageChunk
      // Before the fix, this would fail because of duplicate module instances
      expect(instanceofPassCount).toBe(chunks.length);

      // Success: all chunks passed both instanceof and isInstance checks
    }
  );

  it.concurrent(
    "should work with the recommended isInstance pattern",
    { timeout: 60_000 },
    async () => {
      const model = new ChatOllama({
        model: "tinyllama",
        baseUrl: "http://localhost:11434",
      });

      const stream = await model.stream("Say 'test'");

      for await (const chunk of stream) {
        // This is the recommended pattern from LangChain maintainers
        // It should always work regardless of module instance issues
        expect(AIMessageChunk.isInstance(chunk)).toBe(true);
        expect(chunk.content).toBeDefined();
      }
    }
  );
});
