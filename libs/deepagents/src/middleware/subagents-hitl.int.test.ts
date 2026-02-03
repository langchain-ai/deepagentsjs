/**
 * Integration tests demonstrating the interrupt() primitive in compiled sub-agents.
 *
 * These tests show:
 * 1. Using interrupt() directly inside a sub-agent tool
 * 2. Parent agent invoking the sub-agent which triggers the interrupt
 * 3. Using Command(resume=...) to provide data and resume execution
 */

import { describe, it, expect } from "vitest";
import { v4 as uuidv4 } from "uuid";
import { z } from "zod/v3";

import {
  MemorySaver,
  Command,
  interrupt,
  StateGraph,
  END,
  START,
  Annotation,
} from "@langchain/langgraph";
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";

import { createAgent, tool } from "langchain";

import { createDeepAgent } from "../index.js";
import { CompiledSubAgent } from "./subagents.js";
import { SAMPLE_MODEL } from "../testing/utils.js";

// =============================================================================
// Tools that use interrupt() directly
// =============================================================================

/**
 * Request human approval before proceeding with an action.
 * Uses the interrupt() primitive directly.
 */
const requestApproval = tool(
  async (input: { action_description: string }) => {
    // interrupt() pauses execution and returns the value passed to Command(resume=...)
    const approval = interrupt({
      type: "approval_request",
      action: input.action_description,
      message: `Please approve or reject: ${input.action_description}`,
    }) as { approved?: boolean; reason?: string };

    if (approval?.approved) {
      return `Action '${input.action_description}' was APPROVED. Proceeding...`;
    } else {
      return `Action '${input.action_description}' was REJECTED. Reason: ${approval?.reason || "No reason provided"}`;
    }
  },
  {
    name: "request_approval",
    description:
      "Request human approval before proceeding with an action. Use this when you need explicit human confirmation.",
    schema: z.object({
      action_description: z
        .string()
        .describe("Description of the action requiring approval"),
    }),
  },
);

/**
 * Collect user input for a question.
 * Uses interrupt() to pause and wait for user input.
 */
const askUser = tool(
  async (input: { question: string }) => {
    const response = interrupt({
      type: "user_input",
      question: input.question,
    }) as { answer?: string };

    return `User responded: ${response?.answer || "No answer provided"}`;
  },
  {
    name: "ask_user",
    description:
      "Collect user input for a question. Use this to get information from the user.",
    schema: z.object({
      question: z.string().describe("The question to ask the user"),
    }),
  },
);

/**
 * Perform a multi-step operation that requires confirmation at each step.
 * Demonstrates multiple interrupts in sequence.
 */
const multiStepOperation = tool(
  async (input: { steps: string[] }) => {
    const results: string[] = [];

    for (let i = 0; i < input.steps.length; i++) {
      const step = input.steps[i];
      // Each step can trigger an interrupt
      const confirmation = interrupt({
        type: "step_confirmation",
        step_number: i + 1,
        step_description: step,
        message: `Confirm step ${i + 1}: ${step}`,
      }) as { proceed?: boolean };

      if (confirmation?.proceed) {
        results.push(`Step ${i + 1} completed: ${step}`);
      } else {
        results.push(`Step ${i + 1} skipped: ${step}`);
        break; // Stop if user doesn't want to proceed
      }
    }

    return results.join("\n");
  },
  {
    name: "multi_step_operation",
    description:
      "Perform a multi-step operation that requires confirmation at each step.",
    schema: z.object({
      steps: z.array(z.string()).describe("List of steps to perform"),
    }),
  },
);

describe("Subagent HITL Integration Tests - interrupt() primitive", () => {
  // =============================================================================
  // Test 1: Basic interrupt() in a CompiledSubAgent
  // =============================================================================
  /**
   * skipping, expect to pass in the future
   */
  it.concurrent.skip(
    "should handle interrupt() in a CompiledSubAgent tool",
    { timeout: 120000 },
    async () => {
      const checkpointer = new MemorySaver();

      // Create a compiled sub-agent with tools that use interrupt()
      const compiledSubagent = createAgent({
        model: SAMPLE_MODEL,
        tools: [requestApproval, askUser],
        systemPrompt:
          "You are an approval agent. Use request_approval to get human approval for actions.",
      });

      // Create parent agent with the CompiledSubAgent
      const parentAgent = createDeepAgent({
        checkpointer,
        subagents: [
          {
            name: "approval-agent",
            description:
              "An agent that can request approvals and ask user questions",
            runnable: compiledSubagent,
          } satisfies CompiledSubAgent,
        ],
      });

      const threadId = uuidv4();
      const config = { configurable: { thread_id: threadId } };

      // Step 1: Invoke agent - sub-agent will use request_approval tool
      const result = await parentAgent.invoke(
        {
          messages: [
            new HumanMessage(
              "Use the task tool to launch the approval-agent sub-agent. " +
                "Tell it to use the request_approval tool to request approval for 'deploying to production'.",
            ),
          ],
        },
        config,
      );

      // Check that task tool was called
      const aiMessages = result.messages.filter(AIMessage.isInstance);
      const toolCalls = aiMessages.flatMap((msg) => msg.tool_calls || []);
      expect(toolCalls.some((tc) => tc.name === "task")).toBe(true);

      // Step 2: Check for interrupt
      expect(result.__interrupt__).toBeDefined();
      expect(result.__interrupt__).toHaveLength(1);

      const interruptValue = result.__interrupt__?.[0].value as Record<
        string,
        unknown
      >;
      expect(interruptValue.type).toBe("approval_request");
      expect(interruptValue.action).toBe("deploying to production");
      expect(interruptValue.message).toContain("deploying to production");

      // Step 3: Resume with approval
      const result2 = await parentAgent.invoke(
        new Command({
          resume: { approved: true },
        }),
        config,
      );

      // Step 4: Verify execution completed
      expect(result2.__interrupt__).toBeUndefined();

      // Find the tool response
      const toolMsgs = result2.messages.filter(ToolMessage.isInstance);
      expect(toolMsgs.length).toBeGreaterThan(0);

      // At least one tool message should contain the approval result
      const hasApprovalResult = toolMsgs.some(
        (msg) =>
          typeof msg.content === "string" &&
          msg.content.toLowerCase().includes("approved"),
      );
      expect(hasApprovalResult).toBe(true);
    },
  );

  // =============================================================================
  // Test 2: Custom StateGraph with interrupt()
  // =============================================================================
  it.concurrent(
    "should handle interrupt() in a custom StateGraph sub-agent",
    { timeout: 120000 },
    async () => {
      // Define state - MUST include 'messages' for CompiledSubAgent
      const ReviewState = Annotation.Root({
        messages: Annotation<AIMessage[]>({
          reducer: (left, right) => left.concat(right),
          default: () => [],
        }),
        document: Annotation<string>({
          reducer: (_, right) => right,
          default: () => "",
        }),
        review_result: Annotation<string>({
          reducer: (_, right) => right,
          default: () => "",
        }),
      });

      // Node that uses interrupt() to collect human review
      const collectReview = (state: typeof ReviewState.State) => {
        const document = state.document || "Unknown document";

        // Use interrupt() to pause and collect review
        const review = interrupt({
          type: "document_review",
          document,
          instructions: "Please review this document and provide feedback",
        }) as { feedback?: string; approved?: boolean };

        const feedback = review?.feedback || "No feedback";
        const approved = review?.approved || false;

        const resultText = `Document '${document}' reviewed. Approved: ${approved}. Feedback: ${feedback}`;

        return {
          messages: [new AIMessage({ content: resultText })],
          review_result: resultText,
        };
      };

      // Build the custom StateGraph
      const graphBuilder = new StateGraph(ReviewState)
        .addNode("review", collectReview)
        .addEdge(START, "review")
        .addEdge("review", END);

      const reviewGraph = graphBuilder.compile();

      const checkpointer = new MemorySaver();

      const parentAgent = createDeepAgent({
        checkpointer,
        subagents: [
          {
            name: "document-reviewer",
            description: "Reviews documents and collects human feedback",
            runnable: reviewGraph,
          } satisfies CompiledSubAgent,
        ],
      });

      const threadId = uuidv4();
      const config = { configurable: { thread_id: threadId } };

      // Step 1: Invoke document-reviewer sub-agent
      const result = await parentAgent.invoke(
        {
          messages: [
            new HumanMessage(
              "Use the task tool to launch the document-reviewer sub-agent. " +
                "Pass it the document 'Q4 Financial Report'.",
            ),
          ],
        },
        config,
      );

      // Step 2: Check for interrupt
      expect(result.__interrupt__).toBeDefined();
      expect(result.__interrupt__).toHaveLength(1);

      const interruptValue = result.__interrupt__?.[0].value as Record<
        string,
        unknown
      >;
      expect(interruptValue.type).toBe("document_review");
      expect(interruptValue.instructions).toContain("review this document");

      // Step 3: Resume with review feedback
      const result2 = await parentAgent.invoke(
        new Command({
          resume: {
            approved: true,
            feedback: "Looks good! Minor typo on page 3.",
          },
        }),
        config,
      );

      // Step 4: Verify review completed
      expect(result2.__interrupt__).toBeUndefined();

      const toolMsgs = result2.messages.filter(ToolMessage.isInstance);
      expect(toolMsgs.length).toBeGreaterThan(0);
    },
  );

  // =============================================================================
  // Test 3: Dict-based sub-agent with interrupt() tools
  // =============================================================================
  it.concurrent(
    "should handle interrupt() in dict-based sub-agent tools",
    { timeout: 120000 },
    async () => {
      const checkpointer = new MemorySaver();

      // Create parent agent with dict-based sub-agent that has interrupt() tools
      const parentAgent = createDeepAgent({
        checkpointer,
        subagents: [
          {
            name: "interactive-agent",
            description:
              "An interactive agent that can ask questions and request approvals",
            systemPrompt:
              "You are an interactive agent. Use ask_user to get information from users.",
            tools: [askUser, requestApproval],
          },
        ],
      });

      const threadId = uuidv4();
      const config = { configurable: { thread_id: threadId } };

      // Step 1: Invoke interactive-agent to ask a question
      const result = await parentAgent.invoke(
        {
          messages: [
            new HumanMessage(
              "Use the task tool to launch the interactive-agent sub-agent. " +
                "Tell it to use the ask_user tool to ask 'What is your favorite color?'",
            ),
          ],
        },
        config,
      );

      // Step 2: Check for interrupt
      expect(result.__interrupt__).toBeDefined();
      expect(result.__interrupt__).toHaveLength(1);

      const interruptValue = result.__interrupt__?.[0].value as Record<
        string,
        unknown
      >;
      expect(interruptValue.type).toBe("user_input");
      expect(interruptValue.question).toBe("What is your favorite color?");

      // Step 3: Resume with user's answer
      const result2 = await parentAgent.invoke(
        new Command({
          resume: { answer: "Blue" },
        }),
        config,
      );

      // Step 4: Verify answer was processed
      expect(result2.__interrupt__).toBeUndefined();

      const toolMsgs = result2.messages.filter(ToolMessage.isInstance);
      expect(toolMsgs.length).toBeGreaterThan(0);

      // Check that the response mentions the user's answer
      const hasAnswerResult = toolMsgs.some(
        (msg) =>
          typeof msg.content === "string" &&
          msg.content.toLowerCase().includes("blue"),
      );
      expect(hasAnswerResult).toBe(true);
    },
  );

  // =============================================================================
  // Test 4: Multiple sequential interrupts
  // =============================================================================
  it.concurrent(
    "should handle multiple sequential interrupts in a subagent",
    { timeout: 180000 },
    async () => {
      const checkpointer = new MemorySaver();

      // Create sub-agent with multi-step operation tool
      const compiledSubagent = createAgent({
        model: SAMPLE_MODEL,
        tools: [multiStepOperation],
        systemPrompt:
          "You are a workflow agent. Use multi_step_operation to execute workflows.",
      });

      const parentAgent = createDeepAgent({
        checkpointer,
        subagents: [
          {
            name: "workflow-agent",
            description:
              "Executes multi-step workflows with confirmation at each step",
            runnable: compiledSubagent,
          } satisfies CompiledSubAgent,
        ],
      });

      const threadId = uuidv4();
      const config = { configurable: { thread_id: threadId } };

      // Step 1: Start multi-step operation (3 steps)
      const result = await parentAgent.invoke(
        {
          messages: [
            new HumanMessage(
              "Use the task tool to launch the workflow-agent sub-agent. " +
                "Tell it to use multi_step_operation with steps: ['Initialize database', 'Migrate schema', 'Seed data']",
            ),
          ],
        },
        config,
      );

      let stepCount = 0;
      let currentResult = result;

      // Process interrupts until complete
      while (currentResult.__interrupt__) {
        stepCount++;
        const interruptValue = currentResult.__interrupt__[0].value as Record<
          string,
          unknown
        >;

        expect(interruptValue.type).toBe("step_confirmation");
        expect(interruptValue.step_number).toBe(stepCount);
        expect(typeof interruptValue.step_description).toBe("string");

        // Confirm this step
        currentResult = await parentAgent.invoke(
          new Command({
            resume: { proceed: true },
          }),
          config,
        );

        // Safety limit to prevent infinite loop
        if (stepCount >= 5) {
          break;
        }
      }

      // Verify we processed multiple steps
      expect(stepCount).toBeGreaterThan(0);
      expect(stepCount).toBeLessThanOrEqual(3);

      // Final result should have no more interrupts
      expect(currentResult.__interrupt__).toBeUndefined();

      const toolMsgs = currentResult.messages.filter(ToolMessage.isInstance);
      expect(toolMsgs.length).toBeGreaterThan(0);
    },
  );

  // =============================================================================
  // Test 5: Rejecting an interrupt
  // =============================================================================
  it.concurrent(
    "should properly handle rejected interrupts",
    { timeout: 120000 },
    async () => {
      const checkpointer = new MemorySaver();

      const compiledSubagent = createAgent({
        model: SAMPLE_MODEL,
        tools: [requestApproval],
        systemPrompt:
          "You are an approval agent. Use request_approval to get human approval for actions.",
      });

      const parentAgent = createDeepAgent({
        checkpointer,
        subagents: [
          {
            name: "approval-agent",
            description: "Requests approvals for actions",
            runnable: compiledSubagent,
          } satisfies CompiledSubAgent,
        ],
      });

      const threadId = uuidv4();
      const config = { configurable: { thread_id: threadId } };

      // Step 1: Request approval for a dangerous action
      const result = await parentAgent.invoke(
        {
          messages: [
            new HumanMessage(
              "Use the task tool to launch the approval-agent sub-agent. " +
                "Tell it to request approval for 'delete all production data'.",
            ),
          ],
        },
        config,
      );

      // Step 2: Check for interrupt
      expect(result.__interrupt__).toBeDefined();
      expect(result.__interrupt__).toHaveLength(1);

      const interruptValue = result.__interrupt__?.[0].value as Record<
        string,
        unknown
      >;
      expect(interruptValue.type).toBe("approval_request");
      expect(interruptValue.action).toBe("delete all production data");

      // Step 3: REJECT with reason
      const result2 = await parentAgent.invoke(
        new Command({
          resume: {
            approved: false,
            reason: "This action is too dangerous and not authorized.",
          },
        }),
        config,
      );

      // Step 4: Verify rejection was processed
      expect(result2.__interrupt__).toBeUndefined();

      const toolMsgs = result2.messages.filter(ToolMessage.isInstance);
      expect(toolMsgs.length).toBeGreaterThan(0);

      // Check that at least one tool message contains rejection info
      const hasRejectionResult = toolMsgs.some(
        (msg) =>
          typeof msg.content === "string" &&
          msg.content.toLowerCase().includes("rejected"),
      );
      expect(hasRejectionResult).toBe(true);
    },
  );

  // =============================================================================
  // Test 6: HITL middleware + interrupt() in same subagent
  // =============================================================================
  it.concurrent(
    "should handle both HITL middleware and interrupt() in the same subagent",
    { timeout: 120000 },
    async () => {
      const checkpointer = new MemorySaver();

      // Create a simple tool that requires HITL approval
      const sensitiveOperation = tool(
        (input: { operation: string }) => {
          return `Sensitive operation '${input.operation}' executed successfully.`;
        },
        {
          name: "sensitive_operation",
          description:
            "Performs a sensitive operation that requires HITL approval.",
          schema: z.object({
            operation: z.string().describe("The operation to perform"),
          }),
        },
      );

      // Create parent agent with a subagent that has both:
      // 1. A tool using interrupt() directly (askUser)
      // 2. A tool that uses HITL middleware (sensitiveOperation via interruptOn)
      const parentAgent = createDeepAgent({
        checkpointer,
        subagents: [
          {
            name: "mixed-hitl-agent",
            description:
              "Agent with both interrupt() tools and HITL middleware",
            systemPrompt:
              "You have access to ask_user (uses interrupt directly) and sensitive_operation (uses HITL middleware).",
            tools: [askUser, sensitiveOperation],
            interruptOn: { sensitive_operation: true },
          },
        ],
      });

      const threadId = uuidv4();
      const config = { configurable: { thread_id: threadId } };

      // Test the interrupt() tool (askUser)
      const result = await parentAgent.invoke(
        {
          messages: [
            new HumanMessage(
              "Use the task tool to launch the mixed-hitl-agent sub-agent. " +
                "Tell it to use ask_user to ask 'What is your name?'",
            ),
          ],
        },
        config,
      );

      // Should interrupt from the ask_user tool
      expect(result.__interrupt__).toBeDefined();
      const interruptValue = result.__interrupt__?.[0].value as Record<
        string,
        unknown
      >;
      expect(interruptValue.type).toBe("user_input");
      expect(interruptValue.question).toBe("What is your name?");

      // Resume with answer
      const result2 = await parentAgent.invoke(
        new Command({
          resume: { answer: "Claude" },
        }),
        config,
      );

      expect(result2.__interrupt__).toBeUndefined();
      expect(result2.messages.length).toBeGreaterThan(0);
    },
  );
});
