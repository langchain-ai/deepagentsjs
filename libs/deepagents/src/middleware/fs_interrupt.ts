import { createMiddleware } from "langchain";
import { AIMessage, ToolMessage } from "@langchain/core/messages";
import type { ToolCall } from "@langchain/core/messages/tool";
import { interrupt } from "@langchain/langgraph";
import {
  buildFsInterruptPredicates,
  hasInterruptPermission,
} from "../permissions/interrupt.js";
import type { FilesystemPermission } from "../permissions/types.js";

const ALLOWED_DECISIONS = ["approve", "edit", "reject"] as const;

interface ApproveDecision {
  type: "approve";
}
interface EditDecision {
  type: "edit";
  editedAction: { name: string; args: Record<string, unknown> };
}
interface RejectDecision {
  type: "reject";
  message?: string;
}
type Decision = ApproveDecision | EditDecision | RejectDecision;

/**
 * Options for {@link createFilesystemInterruptMiddleware}.
 */
export interface FilesystemInterruptMiddlewareOptions {
  /** Filesystem permission rules; only `interrupt`-mode rules have an effect. */
  permissions: FilesystemPermission[];
  /**
   * Tool names already handled elsewhere (e.g. via `interruptOn`). These are
   * skipped so the user-supplied human-in-the-loop configuration wins.
   */
  excludeTools?: Iterable<string>;
  /** Prefix used when describing an approval request. */
  descriptionPrefix?: string;
}

function processDecision(
  decision: Decision,
  toolCall: ToolCall,
): { revisedToolCall: ToolCall | null; toolMessage: ToolMessage | null } {
  if (decision.type === "approve") {
    return { revisedToolCall: toolCall, toolMessage: null };
  }
  if (decision.type === "edit") {
    const editedAction = decision.editedAction;
    if (!editedAction || typeof editedAction.name !== "string") {
      throw new Error(
        `Invalid edited action for tool "${toolCall.name}": name must be a string`,
      );
    }
    if (!editedAction.args || typeof editedAction.args !== "object") {
      throw new Error(
        `Invalid edited action for tool "${toolCall.name}": args must be an object`,
      );
    }
    return {
      revisedToolCall: {
        type: "tool_call",
        name: editedAction.name,
        args: editedAction.args,
        id: toolCall.id,
      },
      toolMessage: null,
    };
  }
  if (decision.type === "reject") {
    if (
      decision.message !== undefined &&
      typeof decision.message !== "string"
    ) {
      throw new Error(
        `Tool call response for "${toolCall.name}" must be a string, got ${typeof decision.message}`,
      );
    }
    return {
      revisedToolCall: toolCall,
      toolMessage: new ToolMessage({
        content:
          decision.message ??
          `User rejected the tool call for \`${toolCall.name}\` with id ${toolCall.id}`,
        name: toolCall.name,
        tool_call_id: toolCall.id ?? "",
        status: "error",
      }),
    };
  }
  throw new Error(
    `Unexpected human decision: ${JSON.stringify(decision)}. Decision type ` +
      `'${(decision as Decision).type}' is not allowed for tool '${toolCall.name}'.`,
  );
}

/**
 * Pause filesystem tool calls for human approval when they match an
 * `interrupt`-mode {@link FilesystemPermission} rule.
 *
 * This is the deepagents counterpart to gating `interruptOn` by path: a single
 * tool (e.g. `read_file`) only pauses when its target path matches a rule,
 * rather than on every call. It uses the same interrupt request/response shape
 * as `humanInTheLoopMiddleware`, so resuming works identically — resume with a
 * `HITLResponse` (`{ decisions: [...] }`).
 *
 * Bulk tools (`ls`/`glob`/`grep`) pause whenever their search subtree could
 * overlap an interrupt-mode rule's anchor. Returns a no-op middleware when no
 * `interrupt`-mode rules apply.
 */
export function createFilesystemInterruptMiddleware(
  options: FilesystemInterruptMiddlewareOptions,
) {
  const { permissions, descriptionPrefix } = options;
  const predicates = buildFsInterruptPredicates(
    permissions,
    new Set(options.excludeTools ?? []),
  );
  const prefix = descriptionPrefix ?? "Filesystem operation requires approval";

  return createMiddleware({
    name: "FilesystemInterruptMiddleware",
    afterModel: {
      canJumpTo: ["model"],
      hook: async (state: { messages: unknown[] }) => {
        if (Object.keys(predicates).length === 0) {
          return undefined;
        }
        const messages = state.messages;
        if (!messages.length) {
          return undefined;
        }
        const lastMessage = [...messages]
          .reverse()
          .find((m) => AIMessage.isInstance(m)) as AIMessage | undefined;
        if (!lastMessage || !lastMessage.tool_calls?.length) {
          return undefined;
        }

        const interruptToolCalls: ToolCall[] = [];
        const autoApprovedToolCalls: ToolCall[] = [];
        for (const toolCall of lastMessage.tool_calls) {
          const predicate = predicates[toolCall.name];
          if (predicate && predicate(toolCall.args ?? {})) {
            interruptToolCalls.push(toolCall);
          } else {
            autoApprovedToolCalls.push(toolCall);
          }
        }

        if (interruptToolCalls.length === 0) {
          return undefined;
        }

        const actionRequests = interruptToolCalls.map((toolCall) => ({
          name: toolCall.name,
          args: toolCall.args,
          description: `${prefix}\n\nTool: ${toolCall.name}\nArgs: ${JSON.stringify(
            toolCall.args,
            null,
            2,
          )}`,
        }));
        const reviewConfigs = interruptToolCalls.map((toolCall) => ({
          actionName: toolCall.name,
          allowedDecisions: [...ALLOWED_DECISIONS],
        }));

        const response = (await interrupt({
          actionRequests,
          reviewConfigs,
        })) as { decisions?: Decision[] };
        const decisions = response?.decisions;

        if (!decisions || !Array.isArray(decisions)) {
          throw new Error(
            "Invalid HITLResponse: decisions must be a non-empty array",
          );
        }
        if (decisions.length !== interruptToolCalls.length) {
          throw new Error(
            `Number of human decisions (${decisions.length}) does not match ` +
              `number of hanging tool calls (${interruptToolCalls.length}).`,
          );
        }

        const revisedToolCalls: ToolCall[] = [...autoApprovedToolCalls];
        const artificialToolMessages: ToolMessage[] = [];
        const hasRejectedToolCalls = decisions.some(
          (decision) => decision.type === "reject",
        );

        for (let i = 0; i < decisions.length; i += 1) {
          const decision = decisions[i];
          const toolCall = interruptToolCalls[i];
          const { revisedToolCall, toolMessage } = processDecision(
            decision,
            toolCall,
          );
          if (
            revisedToolCall &&
            (!hasRejectedToolCalls || decision.type === "reject")
          ) {
            revisedToolCalls.push(revisedToolCall);
          }
          if (toolMessage) {
            artificialToolMessages.push(toolMessage);
          }
        }

        lastMessage.tool_calls = revisedToolCalls;
        const jumpTo = hasRejectedToolCalls ? ("model" as const) : undefined;
        return {
          messages: [lastMessage, ...artificialToolMessages],
          jumpTo,
        };
      },
    },
  });
}

export { hasInterruptPermission };
