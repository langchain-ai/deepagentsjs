import { z } from "zod";

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

// Tool interface that matches LangGraph's tool pattern
interface ToolDefinition {
  name: string;
  description: string;
  schema: z.ZodSchema;
  func: (input: any) => Promise<any>;
}

/**
 * Tool for creating and managing todo lists
 */
export const writeTodos: ToolDefinition = {
  name: "writeTodos",
  description: "Use this tool to create and manage a structured task list for your current work session. This helps you track progress, organize complex tasks, and demonstrate thoroughness to the user.",
  schema: WriteTodosSchema,
  func: async ({ todos }) => {
    const todoItems = todos.map((todo: any) => ({
      content: todo.content,
      status: todo.status
    }));

    return {
      todos: todoItems,
      message: `Successfully updated todo list with ${todos.length} items`
    };
  }
};

/**
 * Tool for listing directory contents
 */
export const ls: ToolDefinition = {
  name: "ls",
  description: "List contents of a directory",
  schema: LsSchema,
  func: async ({ path = "." }) => {
    // Simulate file system listing - in a real implementation this would use fs
    const mockFiles = [
      "package.json",
      "tsconfig.json", 
      "src/",
      "node_modules/",
      "README.md"
    ];
    
    return `Contents of ${path}:\n${mockFiles.join('\n')}`;
  }
};

/**
 * Tool for reading file contents
 */
export const readFile: ToolDefinition = {
  name: "readFile",
  description: "Reads a file from the local filesystem. You can access any file directly by using this tool.",
  schema: ReadFileSchema,
  func: async ({ file_path, line_offset = 1, limit = 2000 }) => {
    // Simulate file reading - in a real implementation this would use fs
    const mockContent = `Mock file content for ${file_path} (lines ${line_offset}-${line_offset + limit - 1}):\n// This would contain actual file contents\n// Implementation would use fs.readFileSync or similar`;
    
    return {
      files: {
        [file_path]: {
          content: mockContent,
          path: file_path,
          lastModified: new Date().toISOString()
        }
      },
      message: `Successfully read file: ${file_path}`
    };
  }
};

/**
 * Tool for writing content to files
 */
export const writeFile: ToolDefinition = {
  name: "writeFile",
  description: "Write content to a file",
  schema: WriteFileSchema,
  func: async ({ file_path, content }) => {
    // Simulate file writing - in a real implementation this would use fs
    return {
      files: {
        [file_path]: {
          content: content,
          path: file_path,
          lastModified: new Date().toISOString(),
          written: true
        }
      },
      message: `Successfully wrote ${content.length} characters to file: ${file_path}`
    };
  }
};

/**
 * Tool for editing files with string replacement
 */
export const editFile: ToolDefinition = {
  name: "editFile",
  description: "Performs exact string replacements in files. You must use your Read tool at least once in the conversation before editing.",
  schema: EditFileSchema,
  func: async ({ file_path, old_string, new_string, replace_all = false }) => {
    // In a real implementation, this would:
    // 1. Read the current file content
    // 2. Perform the string replacement
    // 3. Write the updated content back
    
    const action = replace_all ? "all occurrences" : "first occurrence";
    const mockEditedContent = `File ${file_path} edited: replaced ${action} of "${old_string}" with "${new_string}"`;
    
    return {
      files: {
        [file_path]: {
          content: mockEditedContent,
          path: file_path,
          lastModified: new Date().toISOString(),
          edited: true
        }
      },
      message: `Successfully edited file ${file_path}: replaced ${action} of "${old_string}" with "${new_string}"`
    };
  }
};

// Export all tools as an array for easy consumption
export const builtInTools = [
  writeTodos,
  ls,
  readFile,
  writeFile,
  editFile
];

// Export tool schemas for external use
export const toolSchemas = {
  WriteTodosSchema,
  LsSchema,
  ReadFileSchema,
  WriteFileSchema,
  EditFileSchema
};
