/**
 * Vitest setup file — runs once before all test suites.
 *
 * Registers the LangChain custom matchers (toBeAIMessage, toContainToolCall,
 * etc.) so they're available on every `expect()` call across all test files.
 *
 * The import of `@langchain/core/testing` also pulls in the
 * `declare module "vitest"` augmentation that adds the matcher types to
 * vitest's `Matchers` interface, giving full autocomplete and type-safety.
 *
 * See: https://docs.langchain.com/oss/javascript/langchain/test/integration-testing#matcher-reference
 */

import { expect } from "vitest";
import { langchainMatchers } from "langchain";

process.env.ANTHROPIC_API_KEY ??= "test-api-key";

expect.extend(langchainMatchers);
