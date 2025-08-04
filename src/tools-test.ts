// Test file to check basic imports
import { tool } from "@langchain/core/tools";
import { z } from "zod";

const testSchema = z.object({
  test: z.string()
});

export const testTool = tool(
  async ({ test }) => {
    return `Test: ${test}`;
  },
  {
    name: "test",
    description: "Test tool",
    schema: testSchema
  }
);
