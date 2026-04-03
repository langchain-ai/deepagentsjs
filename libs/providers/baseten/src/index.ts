/**
 * @langchain/baseten
 *
 * Baseten LLM provider for LangChain and deepagents.
 *
 * This package provides a `ChatBaseten` class that extends `ChatOpenAI` to connect
 * to Baseten's OpenAI-compatible inference API, enabling access to open-source LLMs
 * hosted on Baseten's infrastructure.
 *
 * @example
 * ```typescript
 * import { ChatBaseten } from "@langchain/baseten";
 * import { createDeepAgent } from "deepagents";
 *
 * const model = new ChatBaseten({
 *   model: "deepseek-ai/DeepSeek-V3.1",
 *   // Uses BASETEN_API_KEY env var by default
 * });
 *
 * const agent = createDeepAgent({ model });
 *
 * const result = await agent.invoke({
 *   messages: [{ role: "user", content: "Hello!" }],
 * });
 * ```
 *
 * @packageDocumentation
 */

export { ChatBaseten, normalizeToolCallChunks } from "./baseten.js";
export { normalizeModelUrl } from "./types.js";
export type { BasetenChatInput } from "./types.js";
