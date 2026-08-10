import { HumanMessage } from "@langchain/core/messages";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { createMiddleware } from "langchain";
import { createDeepAgent } from "../agent.js";
import { StateBackend } from "../backends/state.js";
import { createSummarizationMiddleware } from "../middleware/summarization.js";

const assertHydratedSummaryMessage = createMiddleware({
  name: "AssertHydratedSummaryMessage",
  async wrapModelCall(request, handler) {
    const event = (request.state as Record<string, unknown>)
      ._summarizationEvent as { summaryMessage?: unknown } | undefined;

    if (
      event?.summaryMessage !== undefined &&
      !HumanMessage.isInstance(event.summaryMessage)
    ) {
      throw new Error(
        "Checkpoint restored _summarizationEvent.summaryMessage without HumanMessage hydration",
      );
    }

    return handler(request);
  },
});

/**
 * Deterministic deployment fixture for validating persisted summarization state.
 * The deployment's configured checkpointer is intentionally used instead of a
 * local saver so an SDK integration test exercises its real serde boundary.
 */
export const graph = createDeepAgent({
  model: new FakeListChatModel({
    responses: ["agent response", "agent response", "agent response"],
  }),
  middleware: [
    createSummarizationMiddleware({
      model: new FakeListChatModel({
        responses: ["conversation summary", "updated conversation summary"],
      }),
      backend: new StateBackend(),
      trigger: { type: "messages", value: 3 },
      keep: { type: "messages", value: 1 },
    }),
    assertHydratedSummaryMessage,
  ],
});
