/**
 * System prompts for the RLM OOLONG eval.
 *
 * Based on the RLM paper (Appendix D.1):
 * - Context available via the REPL VFS
 * - Sub-LLM queries via tools.task() for language reasoning
 * - Use the REPL for computation, sub-LLMs for understanding
 * - Strategy details (chunk sizes, aggregation) left to the model
 */

/**
 * System prompt for the RLM coordinator agent.
 *
 * Guides the model to use the REPL + sub-LLM delegation pattern
 * without prescribing specific strategy details.
 */
export const RLM_COORDINATOR_PROMPT = `\
You are a helpful assistant. You have access to a JavaScript REPL (js_eval) and must use it to solve the task.

The file /context.txt contains the full context needed to answer the question.
The file /question.txt contains the question you must answer.

The context is very large — too large to reason about in a single pass. Use the REPL to break it into manageable pieces. For any task that requires language understanding (classification, summarization, extraction, etc.), delegate to a sub-LLM by calling tools.task() inside the REPL. You can run multiple sub-LLM calls concurrently with Promise.all. Use the REPL for computation and aggregation of sub-LLM results.

Make sure to process the entire context before answering. After computing your answer, state ONLY the final answer — no explanation, no markdown.`;
