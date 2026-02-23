/* eslint-disable no-console */
/**
 * Streaming Example: Track Subagent Lifecycle
 *
 * Demonstrates how to monitor the full lifecycle of subagents:
 * pending → running → complete. Uses the "updates" stream mode
 * to detect when the main agent spawns subagents, when they begin
 * executing, and when their results return.
 *
 * Run:
 *   ANTHROPIC_API_KEY="..." bun ./examples/streaming/lifecycle.ts
 */
import { createDeepAgent } from "deepagents";

const agent = createDeepAgent({
  systemPrompt:
    "You are a project coordinator. Always delegate research tasks " +
    "to your researcher subagent using the task tool. " +
    "Keep your final response to one sentence.",
  subagents: [
    {
      name: "researcher",
      description: "Researches topics thoroughly",
      systemPrompt:
        "You are a thorough researcher. Provide a concise summary " +
        "in 2-3 sentences.",
    },
  ],
});

const activeSubagents = new Map<
  string,
  {
    type: string;
    description: string;
    status: "pending" | "running" | "complete";
  }
>();

for await (const [namespace, chunk] of await agent.stream(
  {
    messages: [
      { role: "user", content: "Research the latest AI safety developments" },
    ],
  },
  { streamMode: "updates", subgraphs: true },
)) {
  for (const [nodeName, data] of Object.entries(chunk)) {
    // ─── Phase 1: Detect subagent starting ────────────────────────
    // When the main agent's model_request contains task tool calls,
    // a subagent has been spawned.
    if (namespace.length === 0 && nodeName === "model_request") {
      for (const msg of (data as any).messages ?? []) {
        for (const tc of msg.tool_calls ?? []) {
          if (tc.name === "task") {
            activeSubagents.set(tc.id, {
              type: tc.args?.subagent_type,
              description: tc.args?.description?.slice(0, 80),
              status: "pending",
            });
            console.log(
              `[lifecycle] PENDING  → subagent "${tc.args?.subagent_type}" (${tc.id})`,
            );
          }
        }
      }
    }

    // ─── Phase 2: Detect subagent running ─────────────────────────
    // When we receive events from a tools:UUID namespace, that
    // subagent is actively executing.
    if (namespace.length > 0 && namespace[0].startsWith("tools:")) {
      const pregelId = namespace[0].split(":")[1];
      // Check if any pending subagent needs to be marked running.
      // Note: the pregel task ID differs from the tool_call_id,
      // so we mark any pending subagent as running on first subagent event.
      for (const [, sub] of activeSubagents) {
        if (sub.status === "pending") {
          sub.status = "running";
          console.log(
            `[lifecycle] RUNNING  → subagent "${sub.type}" (pregel: ${pregelId})`,
          );
          break;
        }
      }
    }

    // ─── Phase 3: Detect subagent completing ──────────────────────
    // When the main agent's tools node returns a tool message,
    // the subagent has completed and returned its result.
    if (namespace.length === 0 && nodeName === "tools") {
      for (const msg of (data as any).messages ?? []) {
        if (msg.type === "tool") {
          const subagent = activeSubagents.get(msg.tool_call_id);
          if (subagent) {
            subagent.status = "complete";
            console.log(
              `[lifecycle] COMPLETE → subagent "${subagent.type}" (${msg.tool_call_id})`,
            );
            console.log(
              `  Result preview: ${String(msg.content).slice(0, 120)}...`,
            );
          }
        }
      }
    }
  }
}

// Print final state
console.log("\n--- Final subagent states ---");
for (const [, sub] of activeSubagents) {
  console.log(`  ${sub.type}: ${sub.status}`);
}

/**
 * Output:
 * [lifecycle] PENDING  → subagent "researcher" (toolu_019tRAb4HQ5iabEWdnvEyaRA)
 * [lifecycle] RUNNING  → subagent "researcher" (pregel: 41a71913-8ac1-5396-8a2e-7e0a50caca28)
 * [lifecycle] COMPLETE → subagent "researcher" (toolu_019tRAb4HQ5iabEWdnvEyaRA)
 *   Result preview: I don't have access to the internet or external databases to research the latest AI safety developments. My knowledge wa...
 *
 * --- Final subagent states ---
 *   researcher: complete
 */
