/* eslint-disable no-console */
import "dotenv/config";

import { HumanMessage, AIMessage } from "@langchain/core/messages";

import { createDeepAgent } from "deepagents";
import { WasmshSandbox } from "@langchain/wasmsh";

const systemPrompt = `You are a coding assistant with access to a wasmsh sandbox.

The sandbox is rooted at /workspace and supports bash-compatible shell commands
plus python3. It is not a general Linux container.
`;

async function main() {
  const sandbox = await WasmshSandbox.createNode({
    initialFiles: {
      "/workspace/data.txt": "hello from wasmsh",
    },
  });

  try {
    const agent = createDeepAgent({
      model: "claude-haiku-4-5",
      systemPrompt,
      backend: sandbox,
    });

    const result = await agent.invoke({
      messages: [
        new HumanMessage(
          "Read data.txt with bash, then confirm its contents from python3 and summarize what you found.",
        ),
      ],
    });

    const reply = result.messages.findLast(AIMessage.isInstance);
    if (reply) {
      console.log(reply.content);
    }
  } finally {
    await sandbox.stop();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
