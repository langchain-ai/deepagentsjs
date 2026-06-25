import { createProvider } from "../../src/registry/provider.js";

export const anthropic = createProvider({
  id: "anthropic",
  title: "Anthropic",
  defaultModel: "anthropic:claude-sonnet-4-5-20250929",
  env: [
    {
      name: "ANTHROPIC_API_KEY",
      prompt: "Anthropic API key",
      required: false,
    },
  ],
});
