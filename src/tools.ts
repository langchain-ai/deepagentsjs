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
    // Return state update command for todos
    return {
      todos: todos
    };
  },
  {
    name: "writeTodos",
    description: "Create and manage a structured task list for tracking progress",
    schema: WriteTodosSchema
  }
);

/**
 * Tool for listing directory contents
 */
export const ls = tool(
  async ({ path = "." }) => {
    // Simulate directory listing
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
    // Simulate file reading and return state update
    const mockContent = `Mock content for ${file_path} (lines ${line_offset}-${line_offset + limit})`;
    return {
      files: {
        [file_path]: {
          content: mockContent,
          path: file_path,
          lastModified: new Date().toISOString()
        }
      }
    };
  },
  {
    name: "readFile",
    description: "Read file contents from the filesystem",
    schema: ReadFileSchema
  }
);

/**
 * Tool for writing content to files
 */
export const writeFile = tool(
  async ({ file_path, content }) => {
    // Simulate file writing and return state update
    return {
      files: {
        [file_path]: {
          content: content,
          path: file_path,
          lastModified: new Date().toISOString(),
          written: true
        }
      }
    };
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
    // Simulate file editing and return state update
    const mockEditedContent = `File ${file_path} edited: replaced "${old_string}" with "${new_string}" (replace_all: ${replace_all})`;
    return {
      files: {
        [file_path]: {
          content: mockEditedContent,
          path: file_path,
          lastModified: new Date().toISOString(),
          edited: true
        }
      }
    };
  },
  {
    name: "editFile",
    description: "Edit files with exact string replacement",
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



