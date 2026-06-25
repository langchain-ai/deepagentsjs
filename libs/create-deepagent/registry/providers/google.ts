import { createProvider } from "../../src/registry/provider.js";

export const google = createProvider({
  id: "google-genai",
  title: "Google",
  defaultModel: "gemini-3.5-flash",
  env: [
    {
      name: "GOOGLE_API_KEY",
      prompt: "Google API key",
      required: false,
    },
  ],
});
