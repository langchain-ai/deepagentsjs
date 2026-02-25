/**
 * Message and content adapter for ACP <-> LangChain translation
 *
 * This module handles the conversion between ACP message formats
 * and LangChain/LangGraph message formats.
 */

import { HumanMessage, AIMessage, BaseMessage } from "@langchain/core/messages";
import type { ContentBlock } from "@agentclientprotocol/sdk";

import type { ToolCallInfo, PlanEntry } from "./types.js";

/**
 * Convert ACP content blocks to LangChain message content
 */
export function acpContentToLangChain(
  content: ContentBlock[],
): string | Array<{ type: string; text?: string; image_url?: string }> {
  if (content.length === 1 && content[0].type === "text") {
    return content[0].text;
  }

  return content.map((block) => {
    // Cast to any for flexible type handling across ACP SDK versions
    const b = block as Record<string, unknown>;
    switch (block.type) {
      case "text":
        return { type: "text", text: (block as { text: string }).text };
      case "image": {
        // Handle different image source formats across SDK versions
        const data = b.data as string | undefined;
        const url = b.url as string | undefined;
        const mediaType = b.mediaType as string | undefined;
        if (data) {
          return {
            type: "image_url",
            image_url: `data:${mediaType ?? "image/png"};base64,${data}`,
          };
        }
        return {
          type: "image_url",
          image_url: url ?? "",
        };
      }
      case "resource": {
        // Resources are treated as text content with context
        const resource = b.resource as
          | { uri?: string; text?: string }
          | undefined;
        const uri = resource?.uri ?? "unknown";
        const text = resource?.text ?? "";
        return {
          type: "text",
          text: `[Resource: ${uri}]\n${text}`,
        };
      }
      default:
        return { type: "text", text: String(block) };
    }
  });
}

/**
 * Convert ACP prompt content blocks to a LangChain HumanMessage
 */
export function acpPromptToHumanMessage(content: ContentBlock[]): HumanMessage {
  return new HumanMessage({
    content: acpContentToLangChain(content),
  });
}

/**
 * Convert LangChain message content to ACP content blocks
 */
export function langChainContentToACP(
  content:
    | string
    | Array<{ type: string; text?: string; [key: string]: unknown }>,
): ContentBlock[] {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }

  return content.map((block) => {
    if (block.type === "text" && block.text) {
      return { type: "text", text: block.text };
    }
    // For other types, convert to text representation
    return { type: "text", text: JSON.stringify(block) };
  }) as ContentBlock[];
}

/**
 * Convert LangChain BaseMessage to ACP content blocks
 */
export function langChainMessageToACP(message: BaseMessage): ContentBlock[] {
  return langChainContentToACP(
    message.content as string | Array<{ type: string; text?: string }>,
  );
}

/**
 * Extract tool calls from LangChain AIMessage
 */
export function extractToolCalls(message: AIMessage): ToolCallInfo[] {
  const toolCalls = message.tool_calls ?? [];

  return toolCalls.map((tc) => ({
    id: tc.id ?? crypto.randomUUID(),
    name: tc.name,
    args: tc.args as Record<string, unknown>,
    status: "pending" as const,
  }));
}

/**
 * Convert todo list state to ACP plan entries
 */
export function todosToPlanEntries(
  todos: Array<{
    id: string;
    content: string;
    status: "pending" | "in_progress" | "completed" | "cancelled";
    priority?: string;
  }>,
): PlanEntry[] {
  return todos.map((todo) => ({
    content: todo.content,
    priority: (todo.priority as "high" | "medium" | "low") ?? "medium",
    status:
      todo.status === "cancelled"
        ? "skipped"
        : (todo.status as "pending" | "in_progress" | "completed"),
  }));
}

/**
 * Generate a unique session ID
 */
export function generateSessionId(): string {
  return `sess_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

/**
 * Generate a unique tool call ID
 */
export function generateToolCallId(): string {
  return `call_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

/**
 * Parse file URI to absolute path
 */
export function fileUriToPath(uri: string): string {
  if (uri.startsWith("file://")) {
    return uri.slice(7);
  }
  return uri;
}

/**
 * Convert absolute path to file URI
 */
export function pathToFileUri(path: string): string {
  if (path.startsWith("file://")) {
    return path;
  }
  return `file://${path}`;
}

/**
 * Determine the kind of tool call for ACP display
 */
export function getToolCallKind(
  toolName: string,
): "read" | "edit" | "delete" | "move" | "search" | "execute" | "think" | "fetch" | "other" {
  const readTools = ["read_file", "ls"];
  const searchTools = ["grep", "glob"];
  const editTools = ["write_file", "edit_file"];
  const executeTools = ["execute", "shell", "terminal"];
  const thinkTools = ["write_todos"];

  if (readTools.includes(toolName)) return "read";
  if (searchTools.includes(toolName)) return "search";
  if (editTools.includes(toolName)) return "edit";
  if (executeTools.includes(toolName)) return "execute";
  if (thinkTools.includes(toolName)) return "think";
  return "other";
}

/**
 * Format tool call title for ACP display
 */
export function formatToolCallTitle(
  toolName: string,
  args: Record<string, unknown>,
): string {
  switch (toolName) {
    case "read_file":
      return `Reading ${args.path ?? "file"}`;
    case "write_file":
      return `Writing ${args.path ?? "file"}`;
    case "edit_file":
      return `Editing ${args.path ?? "file"}`;
    case "ls":
      return `Listing ${args.path ?? "directory"}`;
    case "grep":
      return `Searching for "${args.pattern ?? "pattern"}"`;
    case "glob":
      return `Finding files matching ${args.pattern ?? "pattern"}`;
    case "task":
      return `Delegating: ${args.description ?? "subtask"}`;
    case "write_todos":
      return `Planning tasks`;
    default:
      return `Executing ${toolName}`;
  }
}

/**
 * Extract file locations from tool call arguments for ACP follow-along
 */
export function extractToolCallLocations(
  toolName: string,
  args: Record<string, unknown>,
  workspaceRoot?: string,
): Array<{ path: string; line?: number }> | undefined {
  const filePath = args.path as string | undefined;
  if (!filePath) return undefined;

  const toolsWithPaths = ["read_file", "write_file", "edit_file", "ls", "grep", "glob"];
  if (!toolsWithPaths.includes(toolName)) return undefined;

  const absPath = filePath.startsWith("/")
    ? filePath
    : `${workspaceRoot ?? ""}/${filePath}`;

  const line = (args.line ?? args.startLine) as number | undefined;
  return [{ path: absPath, ...(line != null ? { line } : {}) }];
}
