import {
  createMiddleware,
  type AgentMiddleware as _AgentMiddleware,
} from "langchain";
import { AIMessage, HumanMessage, type BaseMessage } from "@langchain/core/messages";

import type {
  ActivityEvent,
  ControlCommand,
  ObserverMiddlewareOptions,
  CaptureConfig,
} from "../observer/types.js";
import {
  DEFAULT_NAMESPACE,
  DEFAULT_MAX_EVENTS,
  writeActivityEvent,
  claimPendingControlCommands,
} from "../observer/store.js";

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 3) + "...";
}

function getMessageText(message: BaseMessage): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === "string") return block;
        if (typeof block === "object" && block !== null && "text" in block) {
          return (block as { text: string }).text;
        }
        return "";
      })
      .join("");
  }
  return String(content ?? "");
}

function isErrorResult(result: any): boolean {
  if (!result) return false;
  if (typeof result === "object" && "content" in result) {
    const content = result.content;
    if (typeof content === "string") {
      return content.startsWith("Error:") || content.startsWith("error:");
    }
  }
  return false;
}

function getToolResultText(result: any): string {
  if (!result) return "";
  if (typeof result === "string") return result;
  if (typeof result === "object" && "content" in result) {
    const content = result.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .map((block: any) => {
          if (typeof block === "string") return block;
          if (block?.text) return block.text;
          return "";
        })
        .join("");
    }
  }
  return JSON.stringify(result);
}

const FILE_TOOL_OPERATIONS: Record<string, "read" | "write" | "edit" | "delete"> = {
  read_file: "read",
  write_file: "write",
  edit_file: "edit",
  delete_file: "delete",
  str_replace: "edit",
};

function extractTouchedFiles(
  request: any,
  _result: any,
): Array<{ path: string; operation: "read" | "write" | "edit" | "delete" }> {
  const toolName = request.toolCall?.name;
  const operation = FILE_TOOL_OPERATIONS[toolName];
  if (!operation) return [];

  const args = request.toolCall?.args;
  const path =
    args?.path ?? args?.filePath ?? args?.file_path ?? args?.file ?? null;
  if (typeof path !== "string") return [];

  return [{ path, operation }];
}

function injectControlCommandsIntoRequest(
  request: any,
  commands: ControlCommand[],
): any {
  if (commands.length === 0) return request;

  const lines = commands.map((cmd) => {
    const payload = cmd.payload;
    const text =
      "text" in payload
        ? payload.text
        : "content" in payload
          ? (payload as { content: string }).content
          : JSON.stringify(payload);
    return `[${cmd.kind}] ${text}`;
  });

  const injectedMessage = new HumanMessage(
    `[Observer — Steering Commands]\nThe following steering commands have been queued for you:\n\n${lines.join("\n")}`,
  );

  const messages = [...(request.messages ?? []), injectedMessage];
  return { ...request, messages };
}

function shouldCapture(
  capture: CaptureConfig | undefined,
  key: keyof CaptureConfig,
): boolean {
  if (!capture) return true;
  return capture[key] !== false;
}

function resolveStore(request: any, optionStore?: import("@langchain/langgraph-checkpoint").BaseStore) {
  return optionStore ?? request.runtime?.store ?? undefined;
}

function resolveIds(
  request: any,
  staticSessionId: string | undefined,
): { sessionId: string | undefined; threadId: string } {
  const threadId =
    request.runtime?.configurable?.thread_id ?? staticSessionId ?? "unknown";
  const sessionId =
    staticSessionId ??
    request.runtime?.configurable?.observer_session_id ??
    request.runtime?.configurable?.thread_id ??
    undefined;
  return { sessionId, threadId };
}

export function createObserverMiddleware(
  options: ObserverMiddlewareOptions = {},
) {
  const {
    namespace = DEFAULT_NAMESPACE,
    sessionId: staticSessionId,
    capture,
    maxEvents = DEFAULT_MAX_EVENTS,
    enableControl = true,
    store: optionStore,
  } = options;

  return createMiddleware({
    name: "ObserverMiddleware",

    wrapModelCall: async (request, handler) => {
      const { sessionId, threadId } = resolveIds(request, staticSessionId);
      const store = resolveStore(request, optionStore);

      let nextRequest = request;

      if (enableControl && sessionId && store) {
        try {
          const pendingCommands = await claimPendingControlCommands(
            store,
            namespace,
            sessionId,
            threadId,
          );

          if (pendingCommands.length > 0) {
            nextRequest = injectControlCommandsIntoRequest(
              request,
              pendingCommands,
            );

            if (shouldCapture(capture, "control")) {
              for (const cmd of pendingCommands) {
                const appliedEvent: ActivityEvent = {
                  id: crypto.randomUUID(),
                  sessionId,
                  threadId,
                  type: "control_applied",
                  timestamp: new Date().toISOString(),
                  controlCommandId: cmd.id,
                  controlKind: cmd.kind,
                  summary: `Applied ${cmd.kind} command`,
                };
                await writeActivityEvent(
                  store,
                  namespace,
                  sessionId,
                  appliedEvent,
                  maxEvents,
                );
              }
            }
          }
        } catch {
          // Graceful degradation
        }
      }

      const response = await handler(nextRequest);

      if (!sessionId || !store) return response;
      if (!shouldCapture(capture, "modelResponses")) return response;

      try {
        let lastMessage: BaseMessage | undefined;
        let stepCount = 1;

        if (AIMessage.isInstance(response)) {
          lastMessage = response;
        } else {
          const messages: BaseMessage[] = (response as any).messages ?? [];
          lastMessage = messages[messages.length - 1];
          stepCount = messages.filter(
            (m) => typeof m._getType === "function" && m._getType() === "ai",
          ).length;
        }

        if (!lastMessage) return response;

        const event: ActivityEvent = {
          id: crypto.randomUUID(),
          sessionId,
          threadId,
          type: "model_response",
          timestamp: new Date().toISOString(),
          step: stepCount,
          content: truncate(getMessageText(lastMessage), 2000),
          toolCalls: (lastMessage as any).tool_calls?.map(
            (tc: { name: string; args: Record<string, unknown> }) => ({
              name: tc.name,
              args: truncate(JSON.stringify(tc.args), 500),
            }),
          ),
          summary: truncate(getMessageText(lastMessage), 200),
        };

        if (shouldCapture(capture, "todos") && (response as any).todos) {
          event.todos = (response as any).todos;
        }

        await writeActivityEvent(store, namespace, sessionId, event, maxEvents);
      } catch {
        // Best-effort: don't crash the agent on observation failure
      }

      return response;
    },

    wrapToolCall: async (request, handler) => {
      const result = await handler(request);

      const { sessionId, threadId } = resolveIds(request, staticSessionId);
      const store = resolveStore(request, optionStore);

      if (!sessionId || !store) return result;
      if (!shouldCapture(capture, "toolResults")) return result;

      try {
        const files = extractTouchedFiles(request, result);

        const event: ActivityEvent = {
          id: crypto.randomUUID(),
          sessionId,
          threadId,
          type: "tool_result",
          timestamp: new Date().toISOString(),
          toolName: (request as any).toolCall?.name,
          success: !isErrorResult(result),
          summary: truncate(getToolResultText(result), 1000),
        };

        if (shouldCapture(capture, "files") && files.length > 0) {
          event.files = files;
        }

        await writeActivityEvent(store, namespace, sessionId, event, maxEvents);
      } catch {
        // Best-effort: don't crash the agent on observation failure
      }

      return result;
    },
  });
}
