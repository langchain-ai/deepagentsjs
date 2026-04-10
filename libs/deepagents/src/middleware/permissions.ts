/**
 * Permission types and middleware for filesystem access control.
 *
 * Defines `FilesystemPermission` rules and enforces them via `wrapToolCall`.
 */

import {
  createMiddleware,
  ToolMessage,
  type AgentMiddleware as _AgentMiddleware,
} from "langchain";
import { Command, isCommand } from "@langchain/langgraph";
import micromatch from "micromatch";

import type {
  AnyBackendProtocol,
  BackendFactory,
} from "../backends/protocol.js";
import { isSandboxBackend } from "../backends/protocol.js";
import { CompositeBackend } from "../backends/composite.js";
import { truncateIfTooLong } from "../backends/utils.js";

import type * as _langchain from "langchain";

type FilesystemOperation = "read" | "write";

const DEFAULT_FS_TOOL_OPS: Record<string, FilesystemOperation> = {
  ls: "read",
  read_file: "read",
  glob: "read",
  grep: "read",
  write_file: "write",
  edit_file: "write",
};

export interface FilesystemPermission {
  operations: FilesystemOperation[];
  paths: string[];
  mode?: "allow" | "deny";
}

function validatePermissionPaths(paths: string[]): void {
  for (const path of paths) {
    if (!path.startsWith("/")) {
      throw new Error(`Permission path must start with '/': '${path}'`);
    }
    const parts = path.replace(/\\/g, "/").split("/");
    if (parts.includes("..")) {
      throw new Error(`Permission path must not contain '..': '${path}'`);
    }
    if (parts.includes("~")) {
      throw new Error(`Permission path must not contain '~': '${path}'`);
    }
  }
}

export function createFilesystemPermission(
  options: FilesystemPermission,
): Required<FilesystemPermission> {
  validatePermissionPaths(options.paths);
  return {
    operations: options.operations,
    paths: options.paths,
    mode: options.mode ?? "allow",
  };
}

function checkFsPermission(
  rules: Required<FilesystemPermission>[],
  operation: FilesystemOperation,
  path: string,
): "allow" | "deny" {
  for (const rule of rules) {
    if (!rule.operations.includes(operation)) continue;
    if (micromatch.isMatch(path, rule.paths, { dot: true })) {
      return rule.mode;
    }
  }
  return "allow";
}

function filterPathsByPermission(
  rules: Required<FilesystemPermission>[],
  operation: FilesystemOperation,
  paths: string[],
): string[] {
  if (rules.length === 0) return paths;
  return paths.filter(
    (p) => checkFsPermission(rules, operation, p) === "allow",
  );
}

function validatePath(path: string): string {
  const normalized = path.replace(/\/+/g, "/").replace(/\/$/, "") || "/";
  if (normalized.split("/").includes("..")) {
    throw new Error("Path traversal not allowed");
  }
  return normalized;
}

function isCompositeBackend(backend: unknown): backend is CompositeBackend {
  return (
    backend != null &&
    typeof backend === "object" &&
    typeof (backend as CompositeBackend).getRoutePrefixes === "function" &&
    typeof (backend as CompositeBackend).getDefaultBackend === "function"
  );
}

function allPathsScopedToRoutes(
  rules: Required<FilesystemPermission>[],
  backend: AnyBackendProtocol | BackendFactory,
): boolean {
  if (typeof backend === "function") return false;
  if (!isCompositeBackend(backend)) return false;
  const routePrefixes = backend.getRoutePrefixes();
  if (routePrefixes.length === 0) return false;
  for (const rule of rules) {
    for (const path of rule.paths) {
      if (!routePrefixes.some((prefix) => path.startsWith(prefix))) {
        return false;
      }
    }
  }
  return true;
}

function supportsExecution(
  backend: AnyBackendProtocol | BackendFactory,
): boolean {
  if (typeof backend === "function") return false;
  if (isCompositeBackend(backend)) {
    return isSandboxBackend(backend.getDefaultBackend());
  }
  return isSandboxBackend(backend);
}

export function createPermissionMiddleware(options: {
  rules: FilesystemPermission[];
  backend: AnyBackendProtocol | BackendFactory;
}) {
  const normalizedRules = options.rules.map((r) =>
    createFilesystemPermission(r),
  );
  const { backend } = options;

  if (
    supportsExecution(backend) &&
    !allPathsScopedToRoutes(normalizedRules, backend)
  ) {
    throw new Error(
      "PermissionMiddleware does not yet support backends with command " +
        "execution (SandboxBackendProtocol). Tool-level permissions for " +
        "the execute tool are not implemented. Either remove permissions " +
        "or use a backend without execution support.",
    );
  }

  function preCheck(
    toolName: string,
    toolCallId: string | undefined,
    args: Record<string, unknown>,
  ): ToolMessage | null {
    if (normalizedRules.length === 0) return null;
    const operation = DEFAULT_FS_TOOL_OPS[toolName];
    if (!operation) return null;

    const path =
      (args.file_path as string | undefined) ??
      (args.path as string | undefined);
    if (path == null) return null;

    let canonical: string;
    try {
      canonical = validatePath(path);
    } catch {
      return null;
    }

    if (checkFsPermission(normalizedRules, operation, canonical) === "deny") {
      return new ToolMessage({
        content: `Error: permission denied for ${operation} on ${canonical}`,
        name: toolName,
        tool_call_id: toolCallId ?? "",
        status: "error",
      });
    }
    return null;
  }

  function postFilterLs(content: string, _result: unknown): string {
    const lines = content.split("\n").filter((l) => l.trim());
    const filtered = lines.filter((line) => {
      const pathMatch = line.match(/^(\/\S+)/);
      if (!pathMatch) return true;
      const filePath = pathMatch[1].replace(/\s*\(.*\)$/, "");
      return checkFsPermission(normalizedRules, "read", filePath) === "allow";
    });
    return filtered.join("\n");
  }

  function postFilterGlob(content: string): string {
    const paths = content
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("/"));
    const filtered = filterPathsByPermission(normalizedRules, "read", paths);
    if (filtered.length === paths.length) return content;
    if (filtered.length === 0) return "No files found matching pattern";
    const result = truncateIfTooLong(filtered);
    return Array.isArray(result) ? result.join("\n") : result;
  }

  function postFilterGrep(content: string): string {
    const lines = content.split("\n");
    const filtered: string[] = [];
    let currentFile: string | null = null;
    let currentFileAllowed = true;

    for (const line of lines) {
      const fileMatch = line.match(/^(\/\S+):$/);
      if (fileMatch) {
        currentFile = fileMatch[1];
        currentFileAllowed =
          checkFsPermission(normalizedRules, "read", currentFile) === "allow";
        if (currentFileAllowed) filtered.push(line);
        continue;
      }
      if (currentFileAllowed) filtered.push(line);
    }

    if (filtered.length === lines.length) return content;
    const result = filtered.join("\n").trim();
    return result || "No matches found";
  }

  return createMiddleware({
    name: "PermissionMiddleware",
    wrapToolCall: async (request, handler) => {
      const toolName = request.toolCall?.name;
      const args = (request.toolCall?.args as Record<string, unknown>) ?? {};
      const toolCallId = request.toolCall?.id;

      if (toolName) {
        const denial = preCheck(toolName, toolCallId, args);
        if (denial) return denial;
      }

      const result = await handler(request);

      if (normalizedRules.length === 0) return result;

      if (ToolMessage.isInstance(result) && toolName) {
        const content =
          typeof result.content === "string" ? result.content : null;
        if (!content) return result;

        if (toolName === "ls") {
          const filteredContent = postFilterLs(content, result);
          if (filteredContent === content) return result;
          return new ToolMessage({
            content: filteredContent,
            tool_call_id: result.tool_call_id,
            name: result.name,
            id: result.id,
            status: result.status,
            additional_kwargs: result.additional_kwargs,
            response_metadata: result.response_metadata,
          });
        }

        if (toolName === "glob") {
          const filteredContent = postFilterGlob(content);
          if (filteredContent === content) return result;
          return new ToolMessage({
            content: filteredContent,
            tool_call_id: result.tool_call_id,
            name: result.name,
            id: result.id,
            status: result.status,
            additional_kwargs: result.additional_kwargs,
            response_metadata: result.response_metadata,
          });
        }

        if (toolName === "grep") {
          const filteredContent = postFilterGrep(content);
          if (filteredContent === content) return result;
          return new ToolMessage({
            content: filteredContent,
            tool_call_id: result.tool_call_id,
            name: result.name,
            id: result.id,
            status: result.status,
            additional_kwargs: result.additional_kwargs,
            response_metadata: result.response_metadata,
          });
        }
      }

      if (isCommand(result)) {
        const update = result.update as Record<string, unknown> | undefined;
        if (update?.messages && Array.isArray(update.messages)) {
          let changed = false;
          const newMessages = update.messages.map((msg: unknown) => {
            if (!ToolMessage.isInstance(msg)) return msg;
            const content =
              typeof msg.content === "string" ? msg.content : null;
            if (!content || !toolName) return msg;

            let filteredContent: string | null = null;
            if (toolName === "ls") filteredContent = postFilterLs(content, msg);
            else if (toolName === "glob")
              filteredContent = postFilterGlob(content);
            else if (toolName === "grep")
              filteredContent = postFilterGrep(content);

            if (filteredContent && filteredContent !== content) {
              changed = true;
              return new ToolMessage({
                content: filteredContent,
                tool_call_id: msg.tool_call_id,
                name: msg.name,
                id: msg.id,
                status: msg.status,
                additional_kwargs: msg.additional_kwargs,
                response_metadata: msg.response_metadata,
              });
            }
            return msg;
          });

          if (changed) {
            return new Command({
              update: { ...update, messages: newMessages },
            });
          }
        }
      }

      return result;
    },
  });
}

export {
  type FilesystemOperation,
  checkFsPermission,
  filterPathsByPermission,
  validatePath,
  allPathsScopedToRoutes,
  supportsExecution,
};
