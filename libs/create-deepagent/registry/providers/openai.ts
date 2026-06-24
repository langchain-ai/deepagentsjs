import { createProvider } from "../../src/registry/provider.js";

export const openai = createProvider({
  id: "openai",
  title: "OpenAI",
  defaultModel: "openai:gpt-5.4-mini",
  coordinatorModelConfig: 'reasoning: { effort: "low", summary: "auto" }',
  dependency: "@langchain/openai",
  env: [
    {
      name: "OPENAI_API_KEY",
      prompt: "OpenAI API key",
      required: false,
    },
  ],
});
