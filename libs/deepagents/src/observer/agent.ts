import { createAgent } from "langchain";

import type { CreateCompanionAgentParams } from "./types.js";
import { createObserveTool, createSteerTool } from "./tool.js";

const COMPANION_SYSTEM_PROMPT = `You are a companion assistant for a running coding agent. You can observe what
the agent is doing and explain its progress, approach, and visible rationale.

You have access to the \`observe_agent\` tool which retrieves the agent's
current state including recent messages, tool calls, todo state, files being
worked on, and cross-thread activity events.

If steering is enabled, you also have access to a \`steer_agent\` tool that can
queue lightweight commands for the running agent, such as reminders and todo
updates. Use it for small course corrections that should take effect on the
next safe reasoning step.

When the user asks a question, call \`observe_agent\` to get the latest state.
When the user asks to influence the run, call \`steer_agent\` if the request is
safe and scoped. Be concise and focus on what's most relevant.

Do not claim access to hidden chain-of-thought. Only describe what is supported
by the observable transcript, checkpoints, and activity events.

Do not pretend steering is immediate. Explain that commands are queued and will
be applied at the next safe boundary.`;

export function createCompanionAgent(params: CreateCompanionAgentParams) {
  const {
    session,
    model = "claude-haiku-4-20250801",
    systemPrompt,
    checkpointer,
    allowSteering = false,
  } = params;

  const observeTool = createObserveTool(session);
  const tools: any[] = [observeTool];

  if (allowSteering) {
    tools.push(createSteerTool(session));
  }

  const fullPrompt = systemPrompt
    ? `${COMPANION_SYSTEM_PROMPT}\n\n${systemPrompt}`
    : COMPANION_SYSTEM_PROMPT;

  return createAgent({
    model,
    systemPrompt: fullPrompt,
    tools,
    checkpointer,
    name: "companion",
  });
}
