import { describe, it, expect } from "vitest";
import { createModelFile } from "./model.js";
import type { ProviderConfig } from "../provider.js";

const baseProvider: ProviderConfig = {
  id: "openai",
  title: "OpenAI",
  defaultModel: "openai:gpt-5.4-mini",
  package: "@langchain/openai",
  env: [{ name: "OPENAI_API_KEY", prompt: "OpenAI API key" }],
};

describe("createModelFile", () => {
  it("returns a ProviderAwareFile with the correct path", () => {
    const file = createModelFile("lib/agent");
    expect(file.path).toBe("lib/agent/model.ts");
  });

  it("does not include coordinator options when none provided", () => {
    const file = createModelFile("lib/agent");
    const content = file.getContent({ providerConfig: baseProvider });
    expect(content).toMatchInlineSnapshot(`
      "import { initChatModel } from "langchain/chat_models/universal";

      const coordinatorModel = await initChatModel("openai:gpt-5.4-mini");

      const subagentModel = await initChatModel("openai:gpt-5.4-mini");

      export { coordinatorModel, subagentModel };
      "
    `);
  });

  it("handles deeply nested coordinatorModelConfig", () => {
    const file = createModelFile("lib/agent");
    const provider: ProviderConfig = {
      ...baseProvider,
      coordinatorModelConfig: {
        a: { b: { c: { d: "value" } } },
      },
    };
    const content = file.getContent({ providerConfig: provider });
    expect(content).toMatchInlineSnapshot(`
      "import { initChatModel } from "langchain/chat_models/universal";

      const coordinatorModel = await initChatModel("openai:gpt-5.4-mini", {
        a: {
          b: {
            c: {
              d: 'value'
            }
          }
        }
      });

      const subagentModel = await initChatModel("openai:gpt-5.4-mini");

      export { coordinatorModel, subagentModel };
      "
    `);
  });

  it("serializes all JSONValue data types correctly", () => {
    const file = createModelFile("lib/agent");
    const provider: ProviderConfig = {
      ...baseProvider,
      coordinatorModelConfig: {
        stringVal: "hello",
        numberVal: 42,
        booleanVal: true,
        nullVal: null,
        arrayVal: [1, "two", false],
        objectVal: { nested: "deep" },
      },
    };
    const content = file.getContent({ providerConfig: provider });
    expect(content).toMatchInlineSnapshot(`
      "import { initChatModel } from "langchain/chat_models/universal";

      const coordinatorModel = await initChatModel("openai:gpt-5.4-mini", {
        stringVal: 'hello',
        numberVal: 42,
        booleanVal: true,
        nullVal: null,
        arrayVal: [
          1,
          'two',
          false
        ],
        objectVal: {
          nested: 'deep'
        }
      });

      const subagentModel = await initChatModel("openai:gpt-5.4-mini");

      export { coordinatorModel, subagentModel };
      "
    `);
  });
});
