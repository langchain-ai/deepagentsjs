import { createHarnessProfile } from "../create.js";
import { registerHarnessProfileImpl } from "../registry.js";

const SYSTEM_PROMPT_SUFFIX = `\
<use_parallel_tool_calls>
If you intend to call multiple tools and there are no dependencies between the tool calls, make all of the independent tool calls in parallel. Prioritize calling tools simultaneously whenever the actions can be done in parallel rather than sequentially. For example, when reading 3 files, run 3 tool calls in parallel to read all 3 files into context at the same time. Maximize use of parallel tool calls where possible to increase speed and efficiency. However, if some tool calls depend on previous calls to inform dependent values like the parameters, do NOT call these tools in parallel and instead call them sequentially. Never use placeholders or guess missing parameters in tool calls.
</use_parallel_tool_calls>

<investigate_before_answering>
Never speculate about code you have not opened. If the user references a specific file, you MUST read the file before answering. Make sure to investigate and read relevant files BEFORE answering questions about the codebase. Never make any claims about code before investigating unless you are certain of the correct answer - give grounded and hallucination-free answers.
</investigate_before_answering>

<tool_result_reflection>
After receiving tool results, carefully reflect on their quality and determine optimal next steps before proceeding. Use your thinking to plan and iterate based on this new information, and then take the best next action.
</tool_result_reflection>`;

/**
 * Register the built-in Claude Sonnet 4.6 harness profile.
 *
 * Layers universal Claude guidance (parallel tool calls, grounded
 * answers, post-tool reflection) onto `anthropic:claude-sonnet-4-6`.
 *
 * No Sonnet-specific overlays — Anthropic's guidance for Sonnet 4.6
 * centers on API-level configuration rather than system-prompt
 * adjustments. This module exists as the audit anchor: its presence
 * documents the review and justifies the absence of model-specific
 * content.
 *
 * @internal
 */
export function register(): void {
  registerHarnessProfileImpl(
    "anthropic:claude-sonnet-4-6",
    createHarnessProfile({ systemPromptSuffix: SYSTEM_PROMPT_SUFFIX }),
  );
}
