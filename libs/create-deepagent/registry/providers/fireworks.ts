import { createProvider } from "../../src/registry/provider.js";

export const fireworks = createProvider({
  id: "fireworks",
  title: "Fireworks",
  defaultModel: "accounts/fireworks/models/glm-5p1",
  dependencies: ["@langchain/community"],
  env: [
    {
      name: "FIREWORKS_API_KEY",
      prompt: "Fireworks API key",
      required: false,
    },
  ],
});
