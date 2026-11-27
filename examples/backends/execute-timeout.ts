import "dotenv/config";
import path from "node:path";

import { ChatAnthropic } from "@langchain/anthropic";
import { HumanMessage } from "@langchain/core/messages";

import { createDeepAgent, LocalShellBackend } from "deepagents";

const workspaceDir = path.join(process.cwd(), "workspace");

const backend = await LocalShellBackend.create({
  rootDir: workspaceDir,
  virtualMode: true,
  inheritEnv: true,
  timeout: 30,
});

const stuck = await backend.execute("sleep 5", { timeout: 1 });
console.log(stuck.exitCode, stuck.output);

const longBuild = await backend.execute("sleep 35 && echo done", {
  timeout: 60,
});
console.log(longBuild.exitCode, longBuild.output);

export const agent = createDeepAgent({
  model: new ChatAnthropic({
    model: "claude-sonnet-4-5",
    temperature: 0,
  }),
  backend,
});

await agent.invoke({
  messages: [
    new HumanMessage(
      "Run `sleep 45 && echo finished`. It takes longer than the default timeout, so pass a timeout of 60 seconds.",
    ),
  ],
});
