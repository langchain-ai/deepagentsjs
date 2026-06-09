import { registerDeepAgentRunner } from "@deepagents/evals";
import { createDeepAgent } from "deepagents";
import { createCodeInterpreterMiddleware, swarm } from "@langchain/quickjs";
import { ChatAnthropic } from "@langchain/anthropic";
import { createSubagentTool } from "./subagent.js";

registerDeepAgentRunner(
  "claude-sonnet-4-6-swarm",
  (config) =>
    createDeepAgent({
      ...config,
      middleware: [
        createCodeInterpreterMiddleware({
          libraries: [swarm()],
          executionTimeoutMs: -1,
        }) as any,
      ],
      model: new ChatAnthropic({ model: "claude-sonnet-4-6" }),
    }) as any,
);

registerDeepAgentRunner(
  "claude-sonnet-4-6-ptc",
  (config) =>
    createDeepAgent({
      ...config,
      middleware: [
        createCodeInterpreterMiddleware({
          ptc: [
            createSubagentTool({
              agentConfig: {
                ...(config ?? {}),
                model: new ChatAnthropic({ model: "claude-sonnet-4-6" }),
              },
            }),
            "read_file",
            "write_file",
            "edit_file",
            "glob",
          ],
          executionTimeoutMs: -1,
        }) as any,
      ],
      model: new ChatAnthropic({ model: "claude-sonnet-4-6" }),
    }) as any,
);
