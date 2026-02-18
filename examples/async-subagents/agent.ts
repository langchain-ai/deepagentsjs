import { ChatAnthropic } from "@langchain/anthropic";
import { createDeepAgent, type SubAgent } from "deepagents";

const researcher: SubAgent = {
  name: "researcher",
  description:
    "Research a topic in depth. Give this agent a single focused question or topic to investigate.",
  systemPrompt: `You are a thorough researcher. When given a topic or question, provide a detailed, well-structured analysis. Include key facts, context, and nuance. Be comprehensive but concise.`,
};

const analyst: SubAgent = {
  name: "analyst",
  description:
    "Analyze data, compare options, or evaluate trade-offs. Give this agent a clear analytical task.",
  systemPrompt: `You are a sharp analyst. When given a task, break it down systematically. Identify patterns, trade-offs, and actionable insights. Structure your response with clear sections.`,
};

export const agent = createDeepAgent({
  model: new ChatAnthropic({
    model: "claude-opus-4-6",
    temperature: 0,
  }),
  systemPrompt: `You are a supervisor agent that orchestrates research and analysis tasks.

When a user asks a question that benefits from deeper investigation, delegate work to your subagents:
- Use the "researcher" for gathering information on specific topics
- Use the "analyst" for comparing options, evaluating trade-offs, or structured analysis

You can dispatch multiple tasks in parallel when the question has independent sub-parts.
After receiving results from subagents, synthesize their findings into a clear, cohesive answer for the user.`,
  subagents: [researcher, analyst],
});
