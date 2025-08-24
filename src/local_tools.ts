import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { promisify } from 'util';
import { glob as nodeGlob } from 'glob';
import { tool } from "@langchain/core/tools";
import { ToolMessage } from "@langchain/core/messages";
import { z } from "zod";

const globAsync = promisify(nodeGlob);

export interface ToolState {
  [key: string]: any;
}

export function ls(dirPath: string = ".", state?: ToolState): string[] {
  try {
    if (!fs.existsSync(dirPath)) {
      return [`Error: Path '${dirPath}' does not exist`];
    }
    
    const stat = fs.statSync(dirPath);
    if (!stat.isDirectory()) {
      return [`Error: Path '${dirPath}' is not a directory`];
    }

    const items = fs.readdirSync(dirPath);
    return items.sort();
  } catch (e) {
    return [`Error listing directory: ${String(e)}`];
  }
}

export function readFile(
  filePath: string,
  offset: number = 0,
  limit: number = 2000,
  state?: ToolState
): string {
  try {
    if (!fs.existsSync(filePath)) {
      return `Error: File '${filePath}' not found`;
    }

    const stat = fs.statSync(filePath);
    if (!stat.isFile()) {
      return `Error: '${filePath}' is not a file`;
    }

    let content: string;
    try {
      content = fs.readFileSync(filePath, 'utf-8');
    } catch (e) {
      // Try reading with error handling for non-UTF8 content
      const buffer = fs.readFileSync(filePath);
      content = buffer.toString('utf-8', 0, buffer.length);
    }

    if (!content || content.trim() === "") {
      return "System reminder: File exists but has empty contents";
    }

    const lines = content.split('\n');
    const startIdx = offset;
    const endIdx = Math.min(startIdx + limit, lines.length);

    if (startIdx >= lines.length) {
      return `Error: Line offset ${offset} exceeds file length (${lines.length} lines)`;
    }

    const resultLines: string[] = [];
    for (let i = startIdx; i < endIdx; i++) {
      let lineContent = lines[i];
      
      if (lineContent.length > 2000) {
        lineContent = lineContent.substring(0, 2000);
      }

      const lineNumber = i + 1;
      resultLines.push(`${lineNumber.toString().padStart(6)}\t${lineContent}`);
    }

    return resultLines.join('\n');
  } catch (e) {
    return `Error reading file: ${String(e)}`;
  }
}

export function writeFile(
  filePath: string,
  content: string,
  state?: ToolState
): string {
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(filePath, content, 'utf-8');
    return `Successfully wrote to file '${filePath}'`;
  } catch (e) {
    return `Error writing file: ${String(e)}`;
  }
}

export async function glob(
  pattern: string,
  basePath: string = ".",
  maxResults: number = 100,
  includeDirs: boolean = false,
  recursive: boolean = true,
  state?: ToolState
): Promise<string> {
  try {
    if (!fs.existsSync(basePath)) {
      return `Error: Path '${basePath}' does not exist`;
    }

    const stat = fs.statSync(basePath);
    if (!stat.isDirectory()) {
      return `Error: Path '${basePath}' is not a directory`;
    }

    const options = {
      cwd: basePath,
      absolute: true,
      dot: true
    };

    const matches = await globAsync(pattern, options);
    const results: string[] = [];

    for (const match of matches) {
      if (results.length >= maxResults) break;

      const matchStat = fs.statSync(match);
      if (matchStat.isFile()) {
        results.push(match);
      } else if (matchStat.isDirectory() && includeDirs) {
        results.push(match + '/');
      }
    }

    results.sort();

    if (results.length === 0) {
      const searchType = recursive ? "recursive" : "non-recursive";
      const dirsNote = includeDirs ? " (including directories)" : "";
      return `No matches found for pattern '${pattern}' in '${basePath}' (${searchType} search${dirsNote})`;
    }

    const resultCount = results.length;
    let header = `Found ${resultCount} matches for pattern '${pattern}'`;
    if (resultCount >= maxResults) {
      header += ` (limited to ${maxResults} results)`;
    }
    header += ":\n\n";

    return header + results.join('\n');
  } catch (e) {
    return `Error in glob search: ${String(e)}`;
  }
}

export function grep(
  pattern: string,
  files?: string | string[],
  searchPath?: string,
  filePattern: string = "*",
  maxResults: number = 50,
  caseSensitive: boolean = false,
  contextLines: number = 0,
  regex: boolean = false,
  state?: ToolState
): Promise<string> {
  return new Promise((resolve) => {
    try {
      if (!files && !searchPath) {
        resolve("Error: Must provide either 'files' parameter or 'searchPath' parameter");
        return;
      }

      const cmd = ["rg"];
      
      if (regex) {
        cmd.push("-e", pattern);
      } else {
        cmd.push("-F", pattern);
      }
      
      if (!caseSensitive) {
        cmd.push("-i");
      }
      
      if (contextLines > 0) {
        cmd.push("-C", contextLines.toString());
      }
      
      if (maxResults > 0) {
        cmd.push("-m", maxResults.toString());
      }
      
      if (filePattern !== "*") {
        cmd.push("-g", filePattern);
      }
      
      if (files) {
        if (typeof files === 'string') {
          cmd.push(files);
        } else {
          cmd.push(...files);
        }
      } else if (searchPath) {
        cmd.push(searchPath);
      }

      const child = spawn(cmd[0], cmd.slice(1), {
        cwd: searchPath && fs.existsSync(searchPath) && fs.statSync(searchPath).isDirectory() ? searchPath : undefined,
        stdio: ['pipe', 'pipe', 'pipe']
      });

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      child.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      const timeout = setTimeout(() => {
        child.kill();
        resolve("Error: ripgrep search timed out");
      }, 30000);

      child.on('close', (code) => {
        clearTimeout(timeout);
        
        if (code === 0) {
          resolve(stdout);
        } else if (code === 1) {
          const patternDesc = regex ? `regex pattern '${pattern}'` : `text '${pattern}'`;
          const caseDesc = caseSensitive ? " (case-sensitive)" : " (case-insensitive)";
          resolve(`No matches found for ${patternDesc}${caseDesc}`);
        } else {
          resolve(`Error running ripgrep: ${stderr}`);
        }
      });

      child.on('error', (err) => {
        clearTimeout(timeout);
        if (err.message.includes('ENOENT')) {
          resolve("Error: ripgrep (rg) not found. Please install ripgrep to use this tool.");
        } else {
          resolve(`Error running ripgrep: ${String(err)}`);
        }
      });

    } catch (e) {
      resolve(`Error in grep search: ${String(e)}`);
    }
  });
}

export function strReplaceBasedEditToolFunction(
  command: "view" | "str_replace" | "create" | "insert",
  filePath: string,
  oldStr?: string,
  newStr?: string,
  viewRange?: [number, number],
  fileText?: string,
  insertLine?: number,
  state?: ToolState
): string {
  try {
    const pathObj = path.resolve(filePath);
    
    if (command === "view") {
      if (fs.existsSync(pathObj)) {
        const stat = fs.statSync(pathObj);
        
        if (stat.isDirectory()) {
          try {
            const items = fs.readdirSync(pathObj);
            const sortedItems = items.map(item => {
              const itemPath = path.join(pathObj, item);
              const itemStat = fs.statSync(itemPath);
              return itemStat.isDirectory() ? `${item}/` : item;
            }).sort();
            return sortedItems.join('\n');
          } catch (e) {
            return `Error listing directory: ${String(e)}`;
          }
        } else if (stat.isFile()) {
          try {
            const content = fs.readFileSync(pathObj, 'utf-8');
            const lines = content.split('\n');
            
            let selectedLines = lines;
            let startNum = 1;
            
            if (viewRange) {
              const [startLine, endLine] = viewRange;
              const startIdx = Math.max(0, startLine - 1);
              const endIdx = Math.min(lines.length, endLine);
              selectedLines = lines.slice(startIdx, endIdx);
              startNum = startLine;
            }
            
            const resultLines = selectedLines.map((line, i) => {
              const lineNum = startNum + i;
              return `${lineNum.toString().padStart(4)} | ${line}`;
            });
            
            return resultLines.length > 0 ? resultLines.join('\n') : "File is empty";
          } catch (e) {
            return `Error: File contains non-UTF-8 content`;
          }
        }
      }
      return `Error: Path '${filePath}' does not exist`;
    }
    
    else if (command === "str_replace") {
      if (!oldStr || newStr === undefined) {
        return "Error: str_replace requires both oldStr and newStr parameters";
      }
      
      if (!fs.existsSync(pathObj)) {
        return `Error: File '${filePath}' not found`;
      }
      
      const stat = fs.statSync(pathObj);
      if (!stat.isFile()) {
        return `Error: '${filePath}' is not a file`;
      }
      
      let content: string;
      try {
        content = fs.readFileSync(pathObj, 'utf-8');
      } catch (e) {
        return `Error: File contains non-UTF-8 content`;
      }
      
      if (!content.includes(oldStr)) {
        return `Error: String not found in file`;
      }
      
      const occurrences = (content.match(new RegExp(oldStr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
      if (occurrences > 1) {
        return `Error: String appears ${occurrences} times. Please provide more specific context.`;
      }
      
      const newContent = content.replace(oldStr, newStr);
      fs.writeFileSync(pathObj, newContent, 'utf-8');
      
      return `Successfully replaced text in '${filePath}'`;
    }
    
    else if (command === "create") {
      if (fileText === undefined) {
        return "Error: create command requires fileText parameter";
      }
      
      if (fs.existsSync(pathObj)) {
        return `Error: File '${filePath}' already exists`;
      }
      
      const dir = path.dirname(pathObj);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      
      fs.writeFileSync(pathObj, fileText, 'utf-8');
      return `Successfully created file '${filePath}'`;
    }
    
    else if (command === "insert") {
      if (newStr === undefined || insertLine === undefined) {
        return "Error: insert command requires both newStr and insertLine parameters";
      }
      
      if (!fs.existsSync(pathObj)) {
        return `Error: File '${filePath}' not found`;
      }
      
      const stat = fs.statSync(pathObj);
      if (!stat.isFile()) {
        return `Error: '${filePath}' is not a file`;
      }
      
      let content: string;
      try {
        content = fs.readFileSync(pathObj, 'utf-8');
      } catch (e) {
        return `Error: File contains non-UTF-8 content`;
      }
      
      const lines = content.split('\n');
      
      if (insertLine < 0 || insertLine > lines.length) {
        return `Error: insertLine ${insertLine} out of range (0-${lines.length})`;
      }
      
      let insertText = newStr;
      if (insertText && !insertText.endsWith('\n')) {
        insertText += '\n';
      }
      
      lines.splice(insertLine, 0, insertText.slice(0, -1)); // Remove the added newline since split/join handles it
      
      fs.writeFileSync(pathObj, lines.join('\n'), 'utf-8');
      return `Successfully inserted text at line ${insertLine} in '${filePath}'`;
    }
    
    else {
      return `Error: Unknown command '${command}'`;
    }
    
  } catch (e) {
    return `Error: ${String(e)}`;
  }
}

// LangChain tool wrappers
export const localLsTool = tool(
  (input: { path?: string }) => {
    return ls(input.path);
  },
  {
    name: "ls",
    description: "List files and directories in the local filesystem",
    schema: z.object({
      path: z.string().optional().default(".").describe("Directory path to list"),
    }),
  },
);

export const localReadFileTool = tool(
  (input: { file_path: string; offset?: number; limit?: number }) => {
    return readFile(input.file_path, input.offset, input.limit);
  },
  {
    name: "read_file",
    description: "Read a file from the local filesystem",
    schema: z.object({
      file_path: z.string().describe("Absolute path to the file to read"),
      offset: z.number().optional().default(0).describe("Line offset to start reading from"),
      limit: z.number().optional().default(2000).describe("Maximum number of lines to read"),
    }),
  },
);

export const localWriteFileTool = tool(
  (input: { file_path: string; content: string }, config) => {
    const result = writeFile(input.file_path, input.content);
    return new ToolMessage({
      content: result,
      tool_call_id: config.toolCall?.id as string,
    });
  },
  {
    name: "write_file",
    description: "Write content to a file in the local filesystem",
    schema: z.object({
      file_path: z.string().describe("Absolute path to the file to write"),
      content: z.string().describe("Content to write to the file"),
    }),
  },
);


export const strReplaceBasedEditTool = tool(
  (input: {
    command: "view" | "str_replace" | "create" | "insert";
    path: string;
    view_range?: [number, number];
    old_str?: string;
    new_str?: string;
    file_text?: string;
    insert_line?: number;
  }, config) => {
    const result = strReplaceBasedEditToolFunction(
      input.command,
      input.path,
      input.old_str,
      input.new_str,
      input.view_range,
      input.file_text,
      input.insert_line
    );
    return new ToolMessage({
      content: result,
      tool_call_id: config.toolCall?.id as string,
    });
  },
  {
    name: "str_replace_based_edit_tool",
    description: "Versatile file editor with view, create, edit, and insert capabilities",
    schema: z.object({
      command: z.enum(["view", "str_replace", "create", "insert"]).describe("Action to perform"),
      path: z.string().describe("Absolute path to the file"),
      view_range: z.tuple([z.number(), z.number()]).optional().describe("Line range for view command [start, end]"),
      old_str: z.string().optional().describe("String to replace (required for str_replace)"),
      new_str: z.string().optional().describe("Replacement string (required for str_replace and insert)"),
      file_text: z.string().optional().describe("Content for new file (required for create)"),
      insert_line: z.number().optional().describe("Line number to insert at (required for insert)"),
    }),
  },
);

export const localGlobTool = tool(
  async (input: { 
    pattern: string; 
    base_path?: string; 
    max_results?: number; 
    include_dirs?: boolean;
    recursive?: boolean;
  }) => {
    return await glob(
      input.pattern, 
      input.base_path, 
      input.max_results, 
      input.include_dirs,
      input.recursive
    );
  },
  {
    name: "glob",
    description: "Find files matching a glob pattern in the local filesystem",
    schema: z.object({
      pattern: z.string().describe("Glob pattern to match files"),
      base_path: z.string().optional().default(".").describe("Base directory to search from"),
      max_results: z.number().optional().default(100).describe("Maximum number of results"),
      include_dirs: z.boolean().optional().default(false).describe("Include directories in results"),
      recursive: z.boolean().optional().default(true).describe("Recursive search"),
    }),
  },
);

export const localGrepTool = tool(
  async (input: {
    pattern: string;
    files?: string | string[];
    search_path?: string;
    file_pattern?: string;
    max_results?: number;
    case_sensitive?: boolean;
    context_lines?: number;
    regex?: boolean;
  }) => {
    return await grep(
      input.pattern,
      input.files,
      input.search_path,
      input.file_pattern,
      input.max_results,
      input.case_sensitive,
      input.context_lines,
      input.regex
    );
  },
  {
    name: "grep",
    description: "Search for text patterns in files using ripgrep",
    schema: z.object({
      pattern: z.string().describe("Text pattern to search for"),
      files: z.union([z.string(), z.array(z.string())]).optional().describe("Specific files to search in"),
      search_path: z.string().optional().describe("Directory to search in"),
      file_pattern: z.string().optional().default("*").describe("File pattern to filter by"),
      max_results: z.number().optional().default(50).describe("Maximum number of results"),
      case_sensitive: z.boolean().optional().default(false).describe("Case sensitive search"),
      context_lines: z.number().optional().default(0).describe("Number of context lines around matches"),
      regex: z.boolean().optional().default(false).describe("Use regex pattern matching"),
    }),
  },
);