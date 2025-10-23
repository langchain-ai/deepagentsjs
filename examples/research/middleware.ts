import { createAgent, tool, humanInTheLoopMiddleware } from "langchain";
import { z } from "zod";

const writeEmail = tool(
  async (args) => `Successfully sent an email to ${args.email}`,
  {
    name: "write_email",
    description: "Send an email",
    schema: z.object({ email: z.string() }),
  }
);

export const agent = createAgent({
  model: "claude-sonnet-4-20250514",
  tools: [writeEmail],
  middleware: [
    humanInTheLoopMiddleware({
      interruptOn: { write_email: { allowedDecisions: ["approve", "reject"] } },
    }),
  ],
});
