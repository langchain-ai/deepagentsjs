import { createProvider } from "../../src/registry/provider.js";

export const fireworks = createProvider({
  id: "fireworks",
  title: "Fireworks",
  defaultModel: "fireworks:accounts/fireworks/models/glm-5p1",
  dependency: "@langchain/fireworks",
  env: [
    {
      name: "FIREWORKS_API_KEY",
      prompt: "Fireworks API key",
      required: false,
    },
  ],
});
