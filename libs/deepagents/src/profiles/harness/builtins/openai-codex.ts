import { createHarnessProfile } from "../create.js";
import { registerHarnessProfileImpl } from "../registry.js";

/**
 * Model specs that receive the Codex harness profile.
 *
 * All variants share the same trained response style, so a single
 * suffix works across the family.
 */
const CODEX_MODEL_SPECS = [
  "openai:gpt-5.1-codex",
  "openai:gpt-5.2-codex",
  "openai:gpt-5.3-codex",
];

const SYSTEM_PROMPT_SUFFIX = `\
## Codex-Specific Behavior

- You are an autonomous senior engineer. Once given a direction, proactively \
gather context, plan, implement, and verify without waiting for additional \
prompts at each step.
- Persist until the task is fully handled end-to-end within the current turn \
whenever feasible. Do not stop at analysis or partial fixes; carry changes \
through implementation, verification, and a clear explanation of outcomes.
- Bias to action: default to implementing with reasonable assumptions. Do not \
end your turn with clarifications unless truly blocked.
- Do not communicate an upfront plan or status preamble before acting. Just act.

## Parallel Tool Use

- Before any tool call, decide ALL files and resources you will need.
- Batch reads, searches, and other independent operations into parallel tool \
calls instead of issuing them one at a time.
- Only make sequential calls when you truly cannot determine the next step \
without seeing a prior result.

## Plan Hygiene

- Before finishing, reconcile every TODO or plan item created via write_todos. \
Mark each as done, blocked (with a one-sentence reason), or cancelled. Do not \
finish with pending items.`;

/**
 * Register the built-in Codex harness profiles.
 *
 * Registers the same profile under each Codex model spec. Per-model
 * keys (not the bare `"openai"` prefix) keep the default behavior of
 * non-Codex OpenAI models unchanged.
 *
 * @internal
 */
export function register(): void {
  const profile = createHarnessProfile({
    systemPromptSuffix: SYSTEM_PROMPT_SUFFIX,
  });
  for (const spec of CODEX_MODEL_SPECS) {
    registerHarnessProfileImpl(spec, profile);
  }
}
