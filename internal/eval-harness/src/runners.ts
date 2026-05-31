import { ChatAnthropic } from "@langchain/anthropic";
import { ChatOpenAI } from "@langchain/openai";
import { createDeepAgent } from "deepagents";
import { registerDeepAgentRunner } from "./deepagent.js";

registerDeepAgentRunner("sonnet-4-5", (config) =>
  createDeepAgent({
    ...config,
    model: new ChatAnthropic({ model: "claude-sonnet-4-5-20250929" }),
  }),
);

registerDeepAgentRunner("sonnet-4-5-thinking", (config) =>
  createDeepAgent({
    ...config,
    model: new ChatAnthropic({
      model: "claude-sonnet-4-5-20250929",
      thinking: { type: "enabled", budget_tokens: 5000 },
    }),
  }),
);

registerDeepAgentRunner("opus-4-6", (config) =>
  createDeepAgent({
    ...config,
    model: new ChatAnthropic({ model: "claude-opus-4-6" }),
  }),
);

registerDeepAgentRunner("sonnet-4-6", (config) =>
  createDeepAgent({
    ...config,
    model: new ChatAnthropic({ model: "claude-sonnet-4-6" }),
  }),
);

registerDeepAgentRunner("gpt-4.1", (config) =>
  createDeepAgent({ ...config, model: new ChatOpenAI({ model: "gpt-4.1" }) }),
);

registerDeepAgentRunner("gpt-4.1-mini", (config) =>
  createDeepAgent({
    ...config,
    model: new ChatOpenAI({ model: "gpt-4.1-mini" }),
  }),
);

registerDeepAgentRunner("o3-mini", (config) =>
  createDeepAgent({ ...config, model: new ChatOpenAI({ model: "o3-mini" }) }),
);
