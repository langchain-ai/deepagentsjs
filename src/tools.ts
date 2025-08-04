import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { Command } from "@langchain/langgraph";
import { Todo } from "./types.js";
import { WRITE_TODOS_DESCRIPTION, EDIT_DESCRIPTION, TOOL_DESCRIPTION } from "./prompts.js";

// Schema definitions for tool inputs
const WriteTodosSchema = z.object({
  todos: z.array(z.object({
    content: z.string().describe("The task description"),
    status: z.enum(["pending", "in_progress", "completed"]).describe("Current status of the task")
  })).describe("Array of todo items to create or update")
});

const LsSchema = z.object({
  path: z.string().optional().describe("Directory path to list (defaults to current directory)")
});

const ReadFileSchema = z.object({
  file_path: z.string().describe("Absolute path to the file to read"),
  line_offset: z.number().optional().describe("Starting line number (1-indexed)"),
  limit: z.number().optional().describe("Maximum number of lines to read")
});

const WriteFileSchema = z.object({
  file_path: z.string().describe("Absolute path to the file to write"),
  content: z.string().describe("Content to write to the file")
});

const EditFileSchema = z.object({
  file_path: z.string().describe("Absolute path to the file to edit"),
  old_string: z.string().describe("Exact string to replace (must be unique in file)"),
  new_string: z.string().describe("New string to replace with"),
  replace_all: z.boolean().optional().describe("Replace all occurrences instead of requiring uniqueness")
});

/**
 * Tool for creating and managing todo lists
 */
export const writeTodos = tool(
  async ({ todos }: z.infer<typeof WriteTodosSchema>): Promise<Command> => {
    const todoItems: Todo[] = todos.map(todo => ({
      content: todo.content,
      status: todo.status
    }));

    return new Command({
      update: {
        todos: todoItems
      }
    });
  },
  {
    name: "writeTodos",
    description: WRITE_TODOS_DESCRIPTION,
    schema: WriteTodosSchema
  }
);

/**
 * Tool for listing directory contents
 */
export const ls = tool(
  async ({ path = "." }: z.infer<typeof LsSchema>): Promise<string> => {
    try {
      // Simulate file system listing - in a real implementation this would use fs
      const mockFiles = [
        "package.json",
        "tsconfig.json", 
        "src/",
        "node_modules/",
        "README.md"
      ];
      
      return `Contents of ${path}:\n${mockFiles.join('\n')}`;
    } catch (error) {
      return `Error listing directory ${path}: ${error}`;
    }
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
  async ({ file_path, line_offset = 1, limit = 2000 }: z.infer<typeof ReadFileSchema>): Promise<Command> => {
    try {
      // Simulate file reading - in a real implementation this would use fs
      const mockContent = `// Mock file content for ${file_path}\n// This would contain actual file contents\n// Line ${line_offset} onwards, up to ${limit} lines`;
      
      // Store file content in state using Command
      return new Command({
        update: {
          files: {
            [file_path]: {
              content: mockContent,
              path: file_path,
              lastModified: new Date().toISOString()
            }
          }
        }
      });
    } catch (error) {
      return new Command({
        update: {
          files: {
            [file_path]: {
              content: `Error reading file: ${error}`,
              path: file_path,
              lastModified: new Date().toISOString(),
              error: true
            }
          }
        }
      });
    }
  },
  {
    name: "readFile", 
    description: TOOL_DESCRIPTION,
    schema: ReadFileSchema
  }
);

/**
 * Tool for writing content to files
 */
export const writeFile = tool(
  async ({ file_path, content }: z.infer<typeof WriteFileSchema>): Promise<Command> => {
    try {
      // Simulate file writing - in a real implementation this would use fs
      return new Command({
        update: {
          files: {
            [file_path]: {
              content: content,
              path: file_path,
              lastModified: new Date().toISOString(),
              written: true
            }
          }
        }
      });
    } catch (error) {
      return new Command({
        update: {
          files: {
            [file_path]: {
              content: `Error writing file: ${error}`,
              path: file_path,
              lastModified: new Date().toISOString(),
              error: true
            }
          }
        }
      });
    }
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
  async ({ file_path, old_string, new_string, replace_all = false }: z.infer<typeof EditFileSchema>): Promise<Command> => {
    try {
      // In a real implementation, this would:
      // 1. Read the current file content
      // 2. Perform the string replacement
      // 3. Write the updated content back
      
      const mockEditedContent = `// File ${file_path} edited\n// Replaced "${old_string}" with "${new_string}"\n// Replace all: ${replace_all}`;
      
      return new Command({
        update: {
          files: {
            [file_path]: {
              content: mockEditedContent,
              path: file_path,
              lastModified: new Date().toISOString(),
              edited: true
            }
          }
        }
      });
    } catch (error) {
      return new Command({
        update: {
          files: {
            [file_path]: {
              content: `Error editing file: ${error}`,
              path: file_path,
              lastModified: new Date().toISOString(),
              error: true
            }
          }
        }
      });
    }
  },
  {
    name: "editFile",
    description: EDIT_DESCRIPTION,
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





