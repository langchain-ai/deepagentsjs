import { ChatOpenAI } from "@langchain/openai";
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
  model: new ChatOpenAI({
    model: "gpt-5-mini",
  }),
  subagents: [researcher],
});
