/**
 * Tool functions for Deep Agents
 *
 * TypeScript versions of all tools using @langchain/core/tools tool() function.
 * Uses getCurrentTaskInput() for state access and returns Command objects for state updates.
 * Implements mock filesystem operations using state.files similar to Python version.
 */

import { createMiddleware, AgentMiddleware, tool, ToolMessage } from "langchain";
import { Command, getCurrentTaskInput } from "@langchain/langgraph";
import { z } from "zod";
import {
  EDIT_DESCRIPTION,
  TOOL_DESCRIPTION,
} from "../prompts.js";

export type { AgentMiddleware };

const stateSchema = z.object({
  files: z.record(z.string(), z.string()),
});
export type FsMiddlewareState = z.infer<typeof stateSchema>;

export const fsMiddleware = createMiddleware({
  name: "fsMiddleware",
  stateSchema,
  modifyModelRequest: async (request) => {
    return {
      ...request,
      tools: [...request.tools, ls, readFile, writeFile, editFile],
    }
  },
});

/**
 * List files tool - returns list of files from state.files
 * Equivalent to Python's ls function
 */
const ls = tool(
  () => {
    const state = getCurrentTaskInput<FsMiddlewareState>();
    const files = state.files || {};
    return Object.keys(files);
  },
  {
    name: "ls",
    description: "List all files in the mock filesystem",
    schema: z.object({}),
  },
);

/**
 * Read file tool - reads from mock filesystem in state.files
 * Matches Python read_file function behavior exactly
 */
const readFile = tool(
  (input: { file_path: string; offset?: number; limit?: number }) => {
    const state = getCurrentTaskInput<FsMiddlewareState>();
    const mockFilesystem = state.files || {};
    const { file_path, offset = 0, limit = 2000 } = input;

    if (!(file_path in mockFilesystem)) {
      return `Error: File '${file_path}' not found`;
    }

    // Get file content
    const content = mockFilesystem[file_path];

    // Handle empty file
    if (!content || content.trim() === "") {
      return "System reminder: File exists but has empty contents";
    }

    // Split content into lines
    const lines = content.split("\n");

    // Apply line offset and limit
    const startIdx = offset;
    const endIdx = Math.min(startIdx + limit, lines.length);

    // Handle case where offset is beyond file length
    if (startIdx >= lines.length) {
      return `Error: Line offset ${offset} exceeds file length (${lines.length} lines)`;
    }

    // Format output with line numbers (cat -n format)
    const resultLines: string[] = [];
    for (let i = startIdx; i < endIdx; i++) {
      let lineContent = lines[i];

      // Truncate lines longer than 2000 characters
      if (lineContent.length > 2000) {
        lineContent = lineContent.substring(0, 2000);
      }

      // Line numbers start at 1, so add 1 to the index
      const lineNumber = i + 1;
      resultLines.push(`${lineNumber.toString().padStart(6)}	${lineContent}`);
    }

    return resultLines.join("\n");
  },
  {
    name: "read_file",
    description: TOOL_DESCRIPTION,
    schema: z.object({
      file_path: z.string().describe("Absolute path to the file to read"),
      offset: z
        .number()
        .optional()
        .default(0)
        .describe("Line offset to start reading from"),
      limit: z
        .number()
        .optional()
        .default(2000)
        .describe("Maximum number of lines to read"),
    }),
  },
);

/**
 * Write file tool - writes to mock filesystem with Command return
 * Matches Python write_file function behavior exactly
 */
const writeFile = tool(
  (
    input: { file_path: string; content: string },
    config,
  ) => {
    const state = getCurrentTaskInput<FsMiddlewareState>();
    const files = { ...(state.files || {}) };
    files[input.file_path] = input.content;

    return new Command({
      update: {
        files: files,
        messages: [
          new ToolMessage({
            content: `Updated file ${input.file_path}`,
            tool_call_id: config.toolCall?.id as string,
          }),
        ],
      },
    });
  },
  {
    name: "write_file",
    description: "Write content to a file in the mock filesystem",
    schema: z.object({
      file_path: z.string().describe("Absolute path to the file to write"),
      content: z.string().describe("Content to write to the file"),
    }),
  },
);

/**
 * Edit file tool - edits files in mock filesystem with Command return
 * Matches Python edit_file function behavior exactly
 */
const editFile = tool(
  (
    input: {
      file_path: string;
      old_string: string;
      new_string: string;
      replace_all?: boolean;
    },
    config,
  ) => {
    const state = getCurrentTaskInput<FsMiddlewareState>();
    const mockFilesystem = { ...(state.files || {}) };
    const { file_path, old_string, new_string, replace_all = false } = input;

    // Check if file exists in mock filesystem
    if (!(file_path in mockFilesystem)) {
      return `Error: File '${file_path}' not found`;
    }

    // Get current file content
    const content = mockFilesystem[file_path];

    // Check if old_string exists in the file
    if (!content.includes(old_string)) {
      return `Error: String not found in file: '${old_string}'`;
    }

    // If not replace_all, check for uniqueness
    if (!replace_all) {
      const escapedOldString = old_string.replace(
        /[.*+?^${}()|[\]\\]/g,
        "\\$&",
      );
      const occurrences = (
        content.match(new RegExp(escapedOldString, "g")) || []
      ).length;
      if (occurrences > 1) {
        return `Error: String '${old_string}' appears ${occurrences} times in file. Use replace_all=True to replace all instances, or provide a more specific string with surrounding context.`;
      } else if (occurrences === 0) {
        return `Error: String not found in file: '${old_string}'`;
      }
    }

    // Perform the replacement
    let newContent: string;

    if (replace_all) {
      const escapedOldString = old_string.replace(
        /[.*+?^${}()|[\]\\]/g,
        "\\$&",
      );
      newContent = content.replace(
        new RegExp(escapedOldString, "g"),
        new_string,
      );
    } else {
      newContent = content.replace(old_string, new_string);
    }

    // Update the mock filesystem
    mockFilesystem[file_path] = newContent;

    return new Command({
      update: {
        files: mockFilesystem,
        messages: [
          new ToolMessage({
            content: `Updated file ${file_path}`,
            tool_call_id: config.toolCall?.id as string,
          }),
        ],
      },
    });
  },
  {
    name: "edit_file",
    description: EDIT_DESCRIPTION,
    schema: z.object({
      file_path: z.string().describe("Absolute path to the file to edit"),
      old_string: z
        .string()
        .describe("String to be replaced (must match exactly)"),
      new_string: z.string().describe("String to replace with"),
      replace_all: z
        .boolean()
        .optional()
        .default(false)
        .describe("Whether to replace all occurrences"),
    }),
  },
);
