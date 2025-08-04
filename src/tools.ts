import { tool } from "@langchain/core/tools";
import { z } from "zod";

// Schema definitions for tool inputs
const WriteTodosSchema = z.object({
  todos: z.array(z.object({
    content: z.string(),
    status: z.enum(["pending", "in_progress", "completed"])
  }))
});

const LsSchema = z.object({
  path: z.string().optional()
});

const ReadFileSchema = z.object({
  file_path: z.string(),
  line_offset: z.number().optional(),
  limit: z.number().optional()
});

const WriteFileSchema = z.object({
  file_path: z.string(),
  content: z.string()
});

const EditFileSchema = z.object({
  file_path: z.string(),
  old_string: z.string(),
  new_string: z.string(),
  replace_all: z.boolean().optional()
});

/**
 * Tool for creating and managing todo lists
 */
export const writeTodos = tool(
  async ({ todos }) => {
    return `Successfully updated todo list with ${todos.length} items`;
  },
  {
    name: "writeTodos",
    description: "Use this tool to create and manage a structured task list for your current work session",
    schema: WriteTodosSchema
  }
);

/**
 * Tool for listing directory contents
 */
export const ls = tool(
  async ({ path = "." }) => {
    const mockFiles = ["package.json", "tsconfig.json", "src/", "README.md"];
    return `Contents of ${path}:\n${mockFiles.join('\n')}`;
  },
  {
    name: "ls",
    description: "List contents of a directory",
    schema: LsSchema
  }
);

/**
 * Tool for reading file contents
 */
export const readFile = tool(
  async ({ file_path, line_offset = 1, limit = 2000 }) => {
    return `Mock file content for ${file_path} (lines ${line_offset}-${line_offset + limit - 1})`;
  },
  {
    name: "readFile", 
    description: "Reads a file from the local filesystem",
    schema: ReadFileSchema
  }
);

/**
 * Tool for writing content to files
 */
export const writeFile = tool(
  async ({ file_path, content }) => {
    return `Successfully wrote ${content.length} characters to file: ${file_path}`;
  },
  {
    name: "writeFile",
    description: "Write content to a file",
    schema: WriteFileSchema
  }
);

/**
 * Tool for editing files with string replacement
 */
export const editFile = tool(
  async ({ file_path, old_string, new_string, replace_all = false }) => {
    const action = replace_all ? "all occurrences" : "first occurrence";
    return `Successfully edited file ${file_path}: replaced ${action} of "${old_string}" with "${new_string}"`;
  },
  {
    name: "editFile",
    description: "Performs exact string replacements in files",
    schema: EditFileSchema
  }
);

// Export all tools as an array for easy consumption
export const builtInTools = [
  writeTodos,
  ls,
  readFile,
  writeFile,
  editFile
];
