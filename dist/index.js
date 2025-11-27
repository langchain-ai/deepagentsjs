import { AIMessage, ToolMessage, anthropicPromptCachingMiddleware, createAgent, createMiddleware, humanInTheLoopMiddleware, summarizationMiddleware, todoListMiddleware, tool } from "langchain";
import { Command, REMOVE_ALL_MESSAGES, getCurrentTaskInput, isCommand } from "@langchain/langgraph";
import { z } from "zod/v3";
import { withLangGraph } from "@langchain/langgraph/zod";
import micromatch from "micromatch";
import * as path from "path";
import { basename } from "path";
import { HumanMessage, RemoveMessage } from "@langchain/core/messages";
import * as fs from "fs/promises";
import * as fsSync from "fs";
import { spawn } from "child_process";
import fg from "fast-glob";

//#region src/backends/utils.ts
const EMPTY_CONTENT_WARNING = "System reminder: File exists but has empty contents";
const MAX_LINE_LENGTH = 1e4;
const LINE_NUMBER_WIDTH = 6;
/**
* Sanitize tool_call_id to prevent path traversal and separator issues.
*
* Replaces dangerous characters (., /, \) with underscores.
*/
function sanitizeToolCallId(toolCallId) {
	return toolCallId.replace(/\./g, "_").replace(/\//g, "_").replace(/\\/g, "_");
}
/**
* Format file content with line numbers (cat -n style).
*
* Chunks lines longer than MAX_LINE_LENGTH with continuation markers (e.g., 5.1, 5.2).
*
* @param content - File content as string or list of lines
* @param startLine - Starting line number (default: 1)
* @returns Formatted content with line numbers and continuation markers
*/
function formatContentWithLineNumbers(content, startLine = 1) {
	let lines;
	if (typeof content === "string") {
		lines = content.split("\n");
		if (lines.length > 0 && lines[lines.length - 1] === "") lines = lines.slice(0, -1);
	} else lines = content;
	const resultLines = [];
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const lineNum = i + startLine;
		if (line.length <= MAX_LINE_LENGTH) resultLines.push(`${lineNum.toString().padStart(LINE_NUMBER_WIDTH)}\t${line}`);
		else {
			const numChunks = Math.ceil(line.length / MAX_LINE_LENGTH);
			for (let chunkIdx = 0; chunkIdx < numChunks; chunkIdx++) {
				const start = chunkIdx * MAX_LINE_LENGTH;
				const end = Math.min(start + MAX_LINE_LENGTH, line.length);
				const chunk = line.substring(start, end);
				if (chunkIdx === 0) resultLines.push(`${lineNum.toString().padStart(LINE_NUMBER_WIDTH)}\t${chunk}`);
				else {
					const continuationMarker = `${lineNum}.${chunkIdx}`;
					resultLines.push(`${continuationMarker.padStart(LINE_NUMBER_WIDTH)}\t${chunk}`);
				}
			}
		}
	}
	return resultLines.join("\n");
}
/**
* Check if content is empty and return warning message.
*
* @param content - Content to check
* @returns Warning message if empty, null otherwise
*/
function checkEmptyContent(content) {
	if (!content || content.trim() === "") return EMPTY_CONTENT_WARNING;
	return null;
}
/**
* Convert FileData to plain string content.
*
* @param fileData - FileData object with 'content' key
* @returns Content as string with lines joined by newlines
*/
function fileDataToString(fileData) {
	return fileData.content.join("\n");
}
/**
* Create a FileData object with timestamps.
*
* @param content - File content as string
* @param createdAt - Optional creation timestamp (ISO format)
* @returns FileData object with content and timestamps
*/
function createFileData(content, createdAt) {
	const lines = typeof content === "string" ? content.split("\n") : content;
	const now = (/* @__PURE__ */ new Date()).toISOString();
	return {
		content: lines,
		created_at: createdAt || now,
		modified_at: now
	};
}
/**
* Update FileData with new content, preserving creation timestamp.
*
* @param fileData - Existing FileData object
* @param content - New content as string
* @returns Updated FileData object
*/
function updateFileData(fileData, content) {
	const lines = typeof content === "string" ? content.split("\n") : content;
	const now = (/* @__PURE__ */ new Date()).toISOString();
	return {
		content: lines,
		created_at: fileData.created_at,
		modified_at: now
	};
}
/**
* Format file data for read response with line numbers.
*
* @param fileData - FileData object
* @param offset - Line offset (0-indexed)
* @param limit - Maximum number of lines
* @returns Formatted content or error message
*/
function formatReadResponse(fileData, offset, limit) {
	const content = fileDataToString(fileData);
	const emptyMsg = checkEmptyContent(content);
	if (emptyMsg) return emptyMsg;
	const lines = content.split("\n");
	const startIdx = offset;
	const endIdx = Math.min(startIdx + limit, lines.length);
	if (startIdx >= lines.length) return `Error: Line offset ${offset} exceeds file length (${lines.length} lines)`;
	return formatContentWithLineNumbers(lines.slice(startIdx, endIdx), startIdx + 1);
}
/**
* Perform string replacement with occurrence validation.
*
* @param content - Original content
* @param oldString - String to replace
* @param newString - Replacement string
* @param replaceAll - Whether to replace all occurrences
* @returns Tuple of [new_content, occurrences] on success, or error message string
*/
function performStringReplacement(content, oldString, newString, replaceAll) {
	const occurrences = content.split(oldString).length - 1;
	if (occurrences === 0) return `Error: String not found in file: '${oldString}'`;
	if (occurrences > 1 && !replaceAll) return `Error: String '${oldString}' appears ${occurrences} times in file. Use replace_all=True to replace all instances, or provide a more specific string with surrounding context.`;
	return [content.split(oldString).join(newString), occurrences];
}
/**
* Validate and normalize a path.
*
* @param path - Path to validate
* @returns Normalized path starting with / and ending with /
* @throws Error if path is invalid
*/
function validatePath(path$1) {
	const pathStr = path$1 || "/";
	if (!pathStr || pathStr.trim() === "") throw new Error("Path cannot be empty");
	let normalized = pathStr.startsWith("/") ? pathStr : "/" + pathStr;
	if (!normalized.endsWith("/")) normalized += "/";
	return normalized;
}
/**
* Search files dict for paths matching glob pattern.
*
* @param files - Dictionary of file paths to FileData
* @param pattern - Glob pattern (e.g., `*.py`, `**\/*.ts`)
* @param path - Base path to search from
* @returns Newline-separated file paths, sorted by modification time (most recent first).
*          Returns "No files found" if no matches.
*
* @example
* ```typescript
* const files = {"/src/main.py": FileData(...), "/test.py": FileData(...)};
* globSearchFiles(files, "*.py", "/");
* // Returns: "/test.py\n/src/main.py" (sorted by modified_at)
* ```
*/
function globSearchFiles(files, pattern, path$1 = "/") {
	let normalizedPath;
	try {
		normalizedPath = validatePath(path$1);
	} catch {
		return "No files found";
	}
	const filtered = Object.fromEntries(Object.entries(files).filter(([fp]) => fp.startsWith(normalizedPath)));
	const effectivePattern = pattern;
	const matches = [];
	for (const [filePath, fileData] of Object.entries(filtered)) {
		let relative = filePath.substring(normalizedPath.length);
		if (relative.startsWith("/")) relative = relative.substring(1);
		if (!relative) {
			const parts = filePath.split("/");
			relative = parts[parts.length - 1] || "";
		}
		if (micromatch.isMatch(relative, effectivePattern, {
			dot: true,
			nobrace: false
		})) matches.push([filePath, fileData.modified_at]);
	}
	matches.sort((a, b) => b[1].localeCompare(a[1]));
	if (matches.length === 0) return "No files found";
	return matches.map(([fp]) => fp).join("\n");
}
/**
* Return structured grep matches from an in-memory files mapping.
*
* Returns a list of GrepMatch on success, or a string for invalid inputs
* (e.g., invalid regex). We deliberately do not raise here to keep backends
* non-throwing in tool contexts and preserve user-facing error messages.
*/
function grepMatchesFromFiles(files, pattern, path$1 = null, glob = null) {
	let regex;
	try {
		regex = new RegExp(pattern);
	} catch (e) {
		return `Invalid regex pattern: ${e.message}`;
	}
	let normalizedPath;
	try {
		normalizedPath = validatePath(path$1);
	} catch {
		return [];
	}
	let filtered = Object.fromEntries(Object.entries(files).filter(([fp]) => fp.startsWith(normalizedPath)));
	if (glob) filtered = Object.fromEntries(Object.entries(filtered).filter(([fp]) => micromatch.isMatch(basename(fp), glob, {
		dot: true,
		nobrace: false
	})));
	const matches = [];
	for (const [filePath, fileData] of Object.entries(filtered)) for (let i = 0; i < fileData.content.length; i++) {
		const line = fileData.content[i];
		const lineNum = i + 1;
		if (regex.test(line)) matches.push({
			path: filePath,
			line: lineNum,
			text: line
		});
	}
	return matches;
}

//#endregion
//#region src/backends/state.ts
/**
* Backend that stores files in agent state (ephemeral).
*
* Uses LangGraph's state management and checkpointing. Files persist within
* a conversation thread but not across threads. State is automatically
* checkpointed after each agent step.
*
* Special handling: Since LangGraph state must be updated via Command objects
* (not direct mutation), operations return filesUpdate in WriteResult/EditResult
* for the middleware to apply via Command.
*/
var StateBackend = class {
	stateAndStore;
	constructor(stateAndStore) {
		this.stateAndStore = stateAndStore;
	}
	/**
	* Get files from current state.
	*/
	getFiles() {
		return this.stateAndStore.state.files || {};
	}
	/**
	* List files and directories in the specified directory (non-recursive).
	*
	* @param path - Absolute path to directory
	* @returns List of FileInfo objects for files and directories directly in the directory.
	*          Directories have a trailing / in their path and is_dir=true.
	*/
	lsInfo(path$1) {
		const files = this.getFiles();
		const infos = [];
		const subdirs = /* @__PURE__ */ new Set();
		const normalizedPath = path$1.endsWith("/") ? path$1 : path$1 + "/";
		for (const [k, fd] of Object.entries(files)) {
			if (!k.startsWith(normalizedPath)) continue;
			const relative = k.substring(normalizedPath.length);
			if (relative.includes("/")) {
				const subdirName = relative.split("/")[0];
				subdirs.add(normalizedPath + subdirName + "/");
				continue;
			}
			const size = fd.content.join("\n").length;
			infos.push({
				path: k,
				is_dir: false,
				size,
				modified_at: fd.modified_at
			});
		}
		for (const subdir of Array.from(subdirs).sort()) infos.push({
			path: subdir,
			is_dir: true,
			size: 0,
			modified_at: ""
		});
		infos.sort((a, b) => a.path.localeCompare(b.path));
		return infos;
	}
	/**
	* Read file content with line numbers.
	*
	* @param filePath - Absolute file path
	* @param offset - Line offset to start reading from (0-indexed)
	* @param limit - Maximum number of lines to read
	* @returns Formatted file content with line numbers, or error message
	*/
	read(filePath, offset = 0, limit = 2e3) {
		const fileData = this.getFiles()[filePath];
		if (!fileData) return `Error: File '${filePath}' not found`;
		return formatReadResponse(fileData, offset, limit);
	}
	/**
	* Read file content as raw FileData.
	*
	* @param filePath - Absolute file path
	* @returns Raw file content as FileData
	*/
	readRaw(filePath) {
		const fileData = this.getFiles()[filePath];
		if (!fileData) throw new Error(`File '${filePath}' not found`);
		return fileData;
	}
	/**
	* Create a new file with content.
	* Returns WriteResult with filesUpdate to update LangGraph state.
	*/
	write(filePath, content) {
		if (filePath in this.getFiles()) return { error: `Cannot write to ${filePath} because it already exists. Read and then make an edit, or write to a new path.` };
		const newFileData = createFileData(content);
		return {
			path: filePath,
			filesUpdate: { [filePath]: newFileData }
		};
	}
	/**
	* Edit a file by replacing string occurrences.
	* Returns EditResult with filesUpdate and occurrences.
	*/
	edit(filePath, oldString, newString, replaceAll = false) {
		const fileData = this.getFiles()[filePath];
		if (!fileData) return { error: `Error: File '${filePath}' not found` };
		const result = performStringReplacement(fileDataToString(fileData), oldString, newString, replaceAll);
		if (typeof result === "string") return { error: result };
		const [newContent, occurrences] = result;
		const newFileData = updateFileData(fileData, newContent);
		return {
			path: filePath,
			filesUpdate: { [filePath]: newFileData },
			occurrences
		};
	}
	/**
	* Structured search results or error string for invalid input.
	*/
	grepRaw(pattern, path$1 = "/", glob = null) {
		return grepMatchesFromFiles(this.getFiles(), pattern, path$1, glob);
	}
	/**
	* Structured glob matching returning FileInfo objects.
	*/
	globInfo(pattern, path$1 = "/") {
		const files = this.getFiles();
		const result = globSearchFiles(files, pattern, path$1);
		if (result === "No files found") return [];
		const paths = result.split("\n");
		const infos = [];
		for (const p of paths) {
			const fd = files[p];
			const size = fd ? fd.content.join("\n").length : 0;
			infos.push({
				path: p,
				is_dir: false,
				size,
				modified_at: fd?.modified_at || ""
			});
		}
		return infos;
	}
};

//#endregion
//#region src/middleware/fs.ts
/**
* Zod v3 schema for FileData (re-export from backends)
*/
const FileDataSchema = z.object({
	content: z.array(z.string()),
	created_at: z.string(),
	modified_at: z.string()
});
/**
* Merge file updates with support for deletions.
*/
function fileDataReducer(left, right) {
	if (left === void 0) {
		const result$1 = {};
		for (const [key, value] of Object.entries(right)) if (value !== null) result$1[key] = value;
		return result$1;
	}
	const result = { ...left };
	for (const [key, value] of Object.entries(right)) if (value === null) delete result[key];
	else result[key] = value;
	return result;
}
/**
* Resolve backend from factory or instance.
*
* @param backend - Backend instance or factory function
* @param stateAndStore - State and store container for backend initialization
*/
function getBackend(backend, stateAndStore) {
	if (typeof backend === "function") return backend(stateAndStore);
	return backend;
}
/**
* Helper to await if Promise, otherwise return value directly.
*/
async function awaitIfPromise(value) {
	return value;
}
const FILESYSTEM_SYSTEM_PROMPT = `You have access to a virtual filesystem. All file paths must start with a /.

- ls: list files in a directory (requires absolute path)
- read_file: read a file from the filesystem
- write_file: write to a file in the filesystem
- edit_file: edit a file in the filesystem
- glob: find files matching a pattern (e.g., "**/*.py")
- grep: search for text within files`;
const LS_TOOL_DESCRIPTION = "List files and directories in a directory";
const READ_FILE_TOOL_DESCRIPTION = "Read the contents of a file";
const WRITE_FILE_TOOL_DESCRIPTION = "Write content to a new file. Returns an error if the file already exists";
const EDIT_FILE_TOOL_DESCRIPTION = "Edit a file by replacing a specific string with a new string";
const GLOB_TOOL_DESCRIPTION = "Find files matching a glob pattern (e.g., '**/*.py' for all Python files)";
const GREP_TOOL_DESCRIPTION = "Search for a regex pattern in files. Returns matching files and line numbers";
/**
* Create ls tool using backend.
*/
function createLsTool(backend, options) {
	const { customDescription } = options;
	return tool(async (input, config) => {
		const resolvedBackend = getBackend(backend, {
			state: getCurrentTaskInput(config),
			store: config.store
		});
		const path$1 = input.path || "/";
		const infos = await awaitIfPromise(resolvedBackend.lsInfo(path$1));
		if (infos.length === 0) return `No files found in ${path$1}`;
		const lines = [];
		for (const info of infos) if (info.is_dir) lines.push(`${info.path} (directory)`);
		else {
			const size = info.size ? ` (${info.size} bytes)` : "";
			lines.push(`${info.path}${size}`);
		}
		return lines.join("\n");
	}, {
		name: "ls",
		description: customDescription || LS_TOOL_DESCRIPTION,
		schema: z.object({ path: z.string().optional().default("/").describe("Directory path to list (default: /)") })
	});
}
/**
* Create read_file tool using backend.
*/
function createReadFileTool(backend, options) {
	const { customDescription } = options;
	return tool(async (input, config) => {
		const resolvedBackend = getBackend(backend, {
			state: getCurrentTaskInput(config),
			store: config.store
		});
		const { file_path, offset = 0, limit = 2e3 } = input;
		return await awaitIfPromise(resolvedBackend.read(file_path, offset, limit));
	}, {
		name: "read_file",
		description: customDescription || READ_FILE_TOOL_DESCRIPTION,
		schema: z.object({
			file_path: z.string().describe("Absolute path to the file to read"),
			offset: z.number({ coerce: true }).optional().default(0).describe("Line offset to start reading from (0-indexed)"),
			limit: z.number({ coerce: true }).optional().default(2e3).describe("Maximum number of lines to read")
		})
	});
}
/**
* Create write_file tool using backend.
*/
function createWriteFileTool(backend, options) {
	const { customDescription, events } = options;
	return tool(async (input, config) => {
		const resolvedBackend = getBackend(backend, {
			state: getCurrentTaskInput(config),
			store: config.store
		});
		const { file_path, content } = input;
		const result = await resolvedBackend.write(file_path, content);
		if (result.error) return result.error;
		const resolved = await events?.onWrite?.(file_path, resolvedBackend) ?? void 0;
		const metadata = await (async () => {
			if (resolved?.kind === "metadata") return resolved.data;
			if (resolved?.kind === "raw-contents") return { ...await resolvedBackend.readRaw(file_path) };
		})();
		const message = new ToolMessage({
			content: `Successfully wrote to '${file_path}'`,
			tool_call_id: config.toolCall?.id,
			name: "write_file",
			metadata
		});
		if (result.filesUpdate) return new Command({ update: {
			files: result.filesUpdate,
			messages: [message]
		} });
		return message;
	}, {
		name: "write_file",
		description: customDescription || WRITE_FILE_TOOL_DESCRIPTION,
		schema: z.object({
			file_path: z.string().describe("Absolute path to the file to write"),
			content: z.string().describe("Content to write to the file")
		})
	});
}
/**
* Create edit_file tool using backend.
*/
function createEditFileTool(backend, options) {
	const { customDescription, events } = options;
	return tool(async (input, config) => {
		const resolvedBackend = getBackend(backend, {
			state: getCurrentTaskInput(config),
			store: config.store
		});
		const { file_path, old_string, new_string, replace_all = false } = input;
		const result = await awaitIfPromise(resolvedBackend.edit(file_path, old_string, new_string, replace_all));
		if (result.error) return result.error;
		const resolved = await events?.onWrite?.(file_path, resolvedBackend) ?? void 0;
		const metadata = await (async () => {
			if (resolved?.kind === "metadata") return resolved.data;
			if (resolved?.kind === "raw-contents") return { ...await resolvedBackend.readRaw(file_path) };
		})();
		const message = new ToolMessage({
			content: `Successfully replaced ${result.occurrences} occurrence(s) in '${file_path}'`,
			tool_call_id: config.toolCall?.id,
			name: "edit_file",
			metadata
		});
		if (result.filesUpdate) return new Command({ update: {
			files: result.filesUpdate,
			messages: [message]
		} });
		return message;
	}, {
		name: "edit_file",
		description: customDescription || EDIT_FILE_TOOL_DESCRIPTION,
		schema: z.object({
			file_path: z.string().describe("Absolute path to the file to edit"),
			old_string: z.string().describe("String to be replaced (must match exactly)"),
			new_string: z.string().describe("String to replace with"),
			replace_all: z.boolean().optional().default(false).describe("Whether to replace all occurrences")
		})
	});
}
/**
* Create glob tool using backend.
*/
function createGlobTool(backend, options) {
	const { customDescription } = options;
	return tool(async (input, config) => {
		const resolvedBackend = getBackend(backend, {
			state: getCurrentTaskInput(config),
			store: config.store
		});
		const { pattern, path: path$1 = "/" } = input;
		const infos = await awaitIfPromise(resolvedBackend.globInfo(pattern, path$1));
		if (infos.length === 0) return `No files found matching pattern '${pattern}'`;
		return infos.map((info) => info.path).join("\n");
	}, {
		name: "glob",
		description: customDescription || GLOB_TOOL_DESCRIPTION,
		schema: z.object({
			pattern: z.string().describe("Glob pattern (e.g., '*.py', '**/*.ts')"),
			path: z.string().optional().default("/").describe("Base path to search from (default: /)")
		})
	});
}
/**
* Create grep tool using backend.
*/
function createGrepTool(backend, options) {
	const { customDescription } = options;
	return tool(async (input, config) => {
		const resolvedBackend = getBackend(backend, {
			state: getCurrentTaskInput(config),
			store: config.store
		});
		const { pattern, path: path$1 = "/", glob = null } = input;
		const result = await awaitIfPromise(resolvedBackend.grepRaw(pattern, path$1, glob));
		if (typeof result === "string") return result;
		if (result.length === 0) return `No matches found for pattern '${pattern}'`;
		const lines = [];
		let currentFile = null;
		for (const match of result) {
			if (match.path !== currentFile) {
				currentFile = match.path;
				lines.push(`\n${currentFile}:`);
			}
			lines.push(`  ${match.line}: ${match.text}`);
		}
		return lines.join("\n");
	}, {
		name: "grep",
		description: customDescription || GREP_TOOL_DESCRIPTION,
		schema: z.object({
			pattern: z.string().describe("Regex pattern to search for"),
			path: z.string().optional().default("/").describe("Base path to search from (default: /)"),
			glob: z.string().optional().nullable().describe("Optional glob pattern to filter files (e.g., '*.py')")
		})
	});
}
/**
* Create filesystem middleware with all tools and features.
*/
function createFilesystemMiddleware(options = {}) {
	const { backend = (stateAndStore) => new StateBackend(stateAndStore), systemPrompt: customSystemPrompt = null, customToolDescriptions = null, toolTokenLimitBeforeEvict = 2e4, events = void 0 } = options;
	const systemPrompt = customSystemPrompt || FILESYSTEM_SYSTEM_PROMPT;
	const tools = [
		createLsTool(backend, {
			customDescription: customToolDescriptions?.ls ?? null,
			events
		}),
		createReadFileTool(backend, {
			customDescription: customToolDescriptions?.read_file ?? null,
			events
		}),
		createWriteFileTool(backend, {
			customDescription: customToolDescriptions?.write_file ?? null,
			events
		}),
		createEditFileTool(backend, {
			customDescription: customToolDescriptions?.edit_file ?? null,
			events
		}),
		createGlobTool(backend, {
			customDescription: customToolDescriptions?.glob ?? null,
			events
		}),
		createGrepTool(backend, {
			customDescription: customToolDescriptions?.grep ?? null,
			events
		})
	];
	return createMiddleware({
		name: "FilesystemMiddleware",
		stateSchema: z.object({ files: withLangGraph(z.record(z.string(), FileDataSchema).default({}), { reducer: {
			fn: fileDataReducer,
			schema: z.record(z.string(), FileDataSchema.nullable())
		} }) }),
		tools,
		wrapModelCall: systemPrompt ? async (request, handler) => {
			const currentSystemPrompt = request.systemPrompt || "";
			const newSystemPrompt = currentSystemPrompt ? `${currentSystemPrompt}\n\n${systemPrompt}` : systemPrompt;
			return handler({
				...request,
				systemPrompt: newSystemPrompt
			});
		} : void 0,
		wrapToolCall: toolTokenLimitBeforeEvict ? (async (request, handler) => {
			const result = await handler(request);
			async function processToolMessage(msg) {
				if (typeof msg.content === "string" && msg.content.length > toolTokenLimitBeforeEvict * 4) {
					const resolvedBackend = getBackend(backend, {
						state: request.state || {},
						store: request.config?.store
					});
					const evictPath = `/large_tool_results/${sanitizeToolCallId(request.toolCall?.id || msg.tool_call_id)}`;
					const writeResult = await awaitIfPromise(resolvedBackend.write(evictPath, msg.content));
					if (writeResult.error) return {
						message: msg,
						filesUpdate: null
					};
					return {
						message: new ToolMessage({
							content: `Tool result too large (${Math.round(msg.content.length / 4)} tokens). Content saved to ${evictPath}`,
							tool_call_id: msg.tool_call_id,
							name: msg.name
						}),
						filesUpdate: writeResult.filesUpdate
					};
				}
				return {
					message: msg,
					filesUpdate: null
				};
			}
			if (result instanceof ToolMessage) {
				const processed = await processToolMessage(result);
				if (processed.filesUpdate) return new Command({ update: {
					files: processed.filesUpdate,
					messages: [processed.message]
				} });
				return processed.message;
			}
			if (isCommand(result)) {
				const update = result.update;
				if (!update?.messages) return result;
				let hasLargeResults = false;
				const accumulatedFiles = {
					...request.state?.files || {},
					...update.files || {}
				};
				const processedMessages = [];
				for (const msg of update.messages) if (msg instanceof ToolMessage) {
					const processed = await processToolMessage(msg);
					processedMessages.push(processed.message);
					if (processed.filesUpdate) {
						hasLargeResults = true;
						Object.assign(accumulatedFiles, processed.filesUpdate);
					}
				} else processedMessages.push(msg);
				if (hasLargeResults) return new Command({ update: {
					...update,
					messages: processedMessages,
					files: accumulatedFiles
				} });
			}
			return result;
		}) : void 0
	});
}

//#endregion
//#region src/middleware/subagents.ts
const DEFAULT_SUBAGENT_PROMPT = "In order to complete the objective that the user asks of you, you have access to a number of standard tools.";
const EXCLUDED_STATE_KEYS = [
	"messages",
	"todos",
	"jumpTo"
];
const DEFAULT_GENERAL_PURPOSE_DESCRIPTION = "General-purpose agent for researching complex questions, searching for files and content, and executing multi-step tasks. When you are searching for a keyword or file and are not confident that you will find the right match in the first few tries use this agent to perform the search for you. This agent has access to all tools as the main agent.";
function getTaskToolDescription(subagentDescriptions) {
	return `
Launch an ephemeral subagent to handle complex, multi-step independent tasks with isolated context windows.

Available agent types and the tools they have access to:
${subagentDescriptions.join("\n")}

When using the Task tool, you must specify a subagent_type parameter to select which agent type to use.

## Usage notes:
1. Launch multiple agents concurrently whenever possible, to maximize performance; to do that, use a single message with multiple tool uses
2. When the agent is done, it will return a single message back to you. The result returned by the agent is not visible to the user. To show the user the result, you should send a text message back to the user with a concise summary of the result.
3. Each agent invocation is stateless. You will not be able to send additional messages to the agent, nor will the agent be able to communicate with you outside of its final report. Therefore, your prompt should contain a highly detailed task description for the agent to perform autonomously and you should specify exactly what information the agent should return back to you in its final and only message to you.
4. The agent's outputs should generally be trusted
5. Clearly tell the agent whether you expect it to create content, perform analysis, or just do research (search, file reads, web fetches, etc.), since it is not aware of the user's intent
6. If the agent description mentions that it should be used proactively, then you should try your best to use it without the user having to ask for it first. Use your judgement.
7. When only the general-purpose agent is provided, you should use it for all tasks. It is great for isolating context and token usage, and completing specific, complex tasks, as it has all the same capabilities as the main agent.

### Example usage of the general-purpose agent:

<example_agent_descriptions>
"general-purpose": use this agent for general purpose tasks, it has access to all tools as the main agent.
</example_agent_descriptions>

<example>
User: "I want to conduct research on the accomplishments of Lebron James, Michael Jordan, and Kobe Bryant, and then compare them."
Assistant: *Uses the task tool in parallel to conduct isolated research on each of the three players*
Assistant: *Synthesizes the results of the three isolated research tasks and responds to the User*
<commentary>
Research is a complex, multi-step task in it of itself.
The research of each individual player is not dependent on the research of the other players.
The assistant uses the task tool to break down the complex objective into three isolated tasks.
Each research task only needs to worry about context and tokens about one player, then returns synthesized information about each player as the Tool Result.
This means each research task can dive deep and spend tokens and context deeply researching each player, but the final result is synthesized information, and saves us tokens in the long run when comparing the players to each other.
</commentary>
</example>

<example>
User: "Analyze a single large code repository for security vulnerabilities and generate a report."
Assistant: *Launches a single \`task\` subagent for the repository analysis*
Assistant: *Receives report and integrates results into final summary*
<commentary>
Subagent is used to isolate a large, context-heavy task, even though there is only one. This prevents the main thread from being overloaded with details.
If the user then asks followup questions, we have a concise report to reference instead of the entire history of analysis and tool calls, which is good and saves us time and money.
</commentary>
</example>

<example>
User: "Schedule two meetings for me and prepare agendas for each."
Assistant: *Calls the task tool in parallel to launch two \`task\` subagents (one per meeting) to prepare agendas*
Assistant: *Returns final schedules and agendas*
<commentary>
Tasks are simple individually, but subagents help silo agenda preparation.
Each subagent only needs to worry about the agenda for one meeting.
</commentary>
</example>

<example>
User: "I want to order a pizza from Dominos, order a burger from McDonald's, and order a salad from Subway."
Assistant: *Calls tools directly in parallel to order a pizza from Dominos, a burger from McDonald's, and a salad from Subway*
<commentary>
The assistant did not use the task tool because the objective is super simple and clear and only requires a few trivial tool calls.
It is better to just complete the task directly and NOT use the \`task\`tool.
</commentary>
</example>

### Example usage with custom agents:

<example_agent_descriptions>
"content-reviewer": use this agent after you are done creating significant content or documents
"greeting-responder": use this agent when to respond to user greetings with a friendly joke
"research-analyst": use this agent to conduct thorough research on complex topics
</example_agent_description>

<example>
user: "Please write a function that checks if a number is prime"
assistant: Sure let me write a function that checks if a number is prime
assistant: First let me use the Write tool to write a function that checks if a number is prime
assistant: I'm going to use the Write tool to write the following code:
<code>
function isPrime(n) {
  if (n <= 1) return false
  for (let i = 2; i * i <= n; i++) {
    if (n % i === 0) return false
  }
  return true
}
</code>
<commentary>
Since significant content was created and the task was completed, now use the content-reviewer agent to review the work
</commentary>
assistant: Now let me use the content-reviewer agent to review the code
assistant: Uses the Task tool to launch with the content-reviewer agent
</example>

<example>
user: "Can you help me research the environmental impact of different renewable energy sources and create a comprehensive report?"
<commentary>
This is a complex research task that would benefit from using the research-analyst agent to conduct thorough analysis
</commentary>
assistant: I'll help you research the environmental impact of renewable energy sources. Let me use the research-analyst agent to conduct comprehensive research on this topic.
assistant: Uses the Task tool to launch with the research-analyst agent, providing detailed instructions about what research to conduct and what format the report should take
</example>

<example>
user: "Hello"
<commentary>
Since the user is greeting, use the greeting-responder agent to respond with a friendly joke
</commentary>
assistant: "I'm going to use the Task tool to launch with the greeting-responder agent"
</example>
  `.trim();
}
const TASK_SYSTEM_PROMPT = `## \`task\` (subagent spawner)

You have access to a \`task\` tool to launch short-lived subagents that handle isolated tasks. These agents are ephemeral — they live only for the duration of the task and return a single result.

When to use the task tool:
- When a task is complex and multi-step, and can be fully delegated in isolation
- When a task is independent of other tasks and can run in parallel
- When a task requires focused reasoning or heavy token/context usage that would bloat the orchestrator thread
- When sandboxing improves reliability (e.g. code execution, structured searches, data formatting)
- When you only care about the output of the subagent, and not the intermediate steps (ex. performing a lot of research and then returned a synthesized report, performing a series of computations or lookups to achieve a concise, relevant answer.)

Subagent lifecycle:
1. **Spawn** → Provide clear role, instructions, and expected output
2. **Run** → The subagent completes the task autonomously
3. **Return** → The subagent provides a single structured result
4. **Reconcile** → Incorporate or synthesize the result into the main thread

When NOT to use the task tool:
- If you need to see the intermediate reasoning or steps after the subagent has completed (the task tool hides them)
- If the task is trivial (a few tool calls or simple lookup)
- If delegating does not reduce token usage, complexity, or context switching
- If splitting would add latency without benefit

## Important Task Tool Usage Notes to Remember
- Whenever possible, parallelize the work that you do. This is true for both tool_calls, and for tasks. Whenever you have independent steps to complete - make tool_calls, or kick off tasks (subagents) in parallel to accomplish them faster. This saves time for the user, which is incredibly important.
- Remember to use the \`task\` tool to silo independent tasks within a multi-part objective.
- You should use the \`task\` tool whenever you have a complex task that will take multiple steps, and is independent from other tasks that the agent needs to complete. These agents are highly competent and efficient.`;
/**
* Filter state to exclude certain keys when passing to subagents
*/
function filterStateForSubagent(state) {
	const filtered = {};
	for (const [key, value] of Object.entries(state)) if (!EXCLUDED_STATE_KEYS.includes(key)) filtered[key] = value;
	return filtered;
}
/**
* Create Command with filtered state update from subagent result
*/
function returnCommandWithStateUpdate(result, toolCallId) {
	const stateUpdate = filterStateForSubagent(result);
	const messages = result.messages;
	const lastMessage = messages?.[messages.length - 1];
	return new Command({ update: {
		...stateUpdate,
		messages: [new ToolMessage({
			content: lastMessage?.content || "Task completed",
			tool_call_id: toolCallId,
			name: "task"
		})]
	} });
}
/**
* Create subagent instances from specifications
*/
function getSubagents(options) {
	const { defaultModel, defaultTools, defaultMiddleware, defaultInterruptOn, subagents, generalPurposeAgent } = options;
	const defaultSubagentMiddleware = defaultMiddleware || [];
	const agents = {};
	const subagentDescriptions = [];
	if (generalPurposeAgent) {
		const generalPurposeMiddleware = [...defaultSubagentMiddleware];
		if (defaultInterruptOn) generalPurposeMiddleware.push(humanInTheLoopMiddleware({ interruptOn: defaultInterruptOn }));
		agents["general-purpose"] = createAgent({
			model: defaultModel,
			systemPrompt: DEFAULT_SUBAGENT_PROMPT,
			tools: defaultTools,
			middleware: generalPurposeMiddleware
		});
		subagentDescriptions.push(`- general-purpose: ${DEFAULT_GENERAL_PURPOSE_DESCRIPTION}`);
	}
	for (const agentParams of subagents) {
		subagentDescriptions.push(`- ${agentParams.name}: ${agentParams.description}`);
		const middleware = agentParams.middleware ? [...defaultSubagentMiddleware, ...agentParams.middleware] : [...defaultSubagentMiddleware];
		const interruptOn = agentParams.interruptOn || defaultInterruptOn;
		if (interruptOn) middleware.push(humanInTheLoopMiddleware({ interruptOn }));
		agents[agentParams.name] = createAgent({
			model: agentParams.model ?? defaultModel,
			systemPrompt: agentParams.systemPrompt,
			tools: agentParams.tools ?? defaultTools,
			middleware
		});
	}
	return {
		agents,
		descriptions: subagentDescriptions
	};
}
/**
* Create the task tool for invoking subagents
*/
function createTaskTool(options) {
	const { defaultModel, defaultTools, defaultMiddleware, defaultInterruptOn, subagents, generalPurposeAgent, taskDescription } = options;
	const { agents: subagentGraphs, descriptions: subagentDescriptions } = getSubagents({
		defaultModel,
		defaultTools,
		defaultMiddleware,
		defaultInterruptOn,
		subagents,
		generalPurposeAgent
	});
	return tool(async (input, config) => {
		const { description, subagent_type } = input;
		if (!(subagent_type in subagentGraphs)) {
			const allowedTypes = Object.keys(subagentGraphs).map((k) => `\`${k}\``).join(", ");
			throw new Error(`Error: invoked agent of type ${subagent_type}, the only allowed types are ${allowedTypes}`);
		}
		const subagent = subagentGraphs[subagent_type];
		const subagentState = filterStateForSubagent(getCurrentTaskInput());
		subagentState.messages = [new HumanMessage({ content: description })];
		const result = await subagent.invoke(subagentState, config);
		if (!config.toolCall?.id) throw new Error("Tool call ID is required for subagent invocation");
		return returnCommandWithStateUpdate(result, config.toolCall.id);
	}, {
		name: "task",
		description: taskDescription ? taskDescription : getTaskToolDescription(subagentDescriptions),
		schema: z.object({
			description: z.string().describe("The task to execute with the selected agent"),
			subagent_type: z.string().describe(`Name of the agent to use. Available: ${Object.keys(subagentGraphs).join(", ")}`)
		})
	});
}
/**
* Create subagent middleware with task tool
*/
function createSubAgentMiddleware(options) {
	const { defaultModel, defaultTools = [], defaultMiddleware = null, defaultInterruptOn = null, subagents = [], systemPrompt = TASK_SYSTEM_PROMPT, generalPurposeAgent = true, taskDescription = null } = options;
	return createMiddleware({
		name: "subAgentMiddleware",
		tools: [createTaskTool({
			defaultModel,
			defaultTools,
			defaultMiddleware,
			defaultInterruptOn,
			subagents,
			generalPurposeAgent,
			taskDescription
		})],
		wrapModelCall: async (request, handler) => {
			if (systemPrompt !== null) {
				const currentPrompt = request.systemPrompt || "";
				const newPrompt = currentPrompt ? `${currentPrompt}\n\n${systemPrompt}` : systemPrompt;
				return handler({
					...request,
					systemPrompt: newPrompt
				});
			}
			return handler(request);
		}
	});
}

//#endregion
//#region src/middleware/patch_tool_calls.ts
/**
* Create middleware that patches dangling tool calls in the messages history.
*
* When an AI message contains tool_calls but subsequent messages don't include
* the corresponding ToolMessage responses, this middleware adds synthetic
* ToolMessages saying the tool call was cancelled.
*
* @returns AgentMiddleware that patches dangling tool calls
*
* @example
* ```typescript
* import { createAgent } from "langchain";
* import { createPatchToolCallsMiddleware } from "./middleware/patch_tool_calls";
*
* const agent = createAgent({
*   model: "claude-sonnet-4-5-20250929",
*   middleware: [createPatchToolCallsMiddleware()],
* });
* ```
*/
function createPatchToolCallsMiddleware() {
	return createMiddleware({
		name: "patchToolCallsMiddleware",
		beforeAgent: async (state) => {
			const messages = state.messages;
			if (!messages || messages.length === 0) return;
			const patchedMessages = [];
			for (let i = 0; i < messages.length; i++) {
				const msg = messages[i];
				patchedMessages.push(msg);
				if (AIMessage.isInstance(msg) && msg.tool_calls != null) {
					for (const toolCall of msg.tool_calls) if (!messages.slice(i).find((m) => ToolMessage.isInstance(m) && m.tool_call_id === toolCall.id)) {
						const toolMsg = `Tool call ${toolCall.name} with id ${toolCall.id} was cancelled - another message came in before it could be completed.`;
						patchedMessages.push(new ToolMessage({
							content: toolMsg,
							name: toolCall.name,
							tool_call_id: toolCall.id
						}));
					}
				}
			}
			return { messages: [new RemoveMessage({ id: REMOVE_ALL_MESSAGES }), ...patchedMessages] };
		}
	});
}

//#endregion
//#region src/backends/store.ts
/**
* Backend that stores files in LangGraph's BaseStore (persistent).
*
* Uses LangGraph's Store for persistent, cross-conversation storage.
* Files are organized via namespaces and persist across all threads.
*
* The namespace can include an optional assistant_id for multi-agent isolation.
*/
var StoreBackend = class {
	stateAndStore;
	constructor(stateAndStore) {
		this.stateAndStore = stateAndStore;
	}
	/**
	* Get the store instance.
	*
	* @returns BaseStore instance
	* @throws Error if no store is available
	*/
	getStore() {
		const store = this.stateAndStore.store;
		if (!store) throw new Error("Store is required but not available in StateAndStore");
		return store;
	}
	/**
	* Get the namespace for store operations.
	*
	* If an assistant_id is available in stateAndStore, return
	* [assistant_id, "filesystem"] to provide per-assistant isolation.
	* Otherwise return ["filesystem"].
	*/
	getNamespace() {
		const namespace = "filesystem";
		const assistantId = this.stateAndStore.assistantId;
		if (assistantId) return [assistantId, namespace];
		return [namespace];
	}
	/**
	* Convert a store Item to FileData format.
	*
	* @param storeItem - The store Item containing file data
	* @returns FileData object
	* @throws Error if required fields are missing or have incorrect types
	*/
	convertStoreItemToFileData(storeItem) {
		const value = storeItem.value;
		if (!value.content || !Array.isArray(value.content) || typeof value.created_at !== "string" || typeof value.modified_at !== "string") throw new Error(`Store item does not contain valid FileData fields. Got keys: ${Object.keys(value).join(", ")}`);
		return {
			content: value.content,
			created_at: value.created_at,
			modified_at: value.modified_at
		};
	}
	/**
	* Convert FileData to a value suitable for store.put().
	*
	* @param fileData - The FileData to convert
	* @returns Object with content, created_at, and modified_at fields
	*/
	convertFileDataToStoreValue(fileData) {
		return {
			content: fileData.content,
			created_at: fileData.created_at,
			modified_at: fileData.modified_at
		};
	}
	/**
	* Search store with automatic pagination to retrieve all results.
	*
	* @param store - The store to search
	* @param namespace - Hierarchical path prefix to search within
	* @param options - Optional query, filter, and page_size
	* @returns List of all items matching the search criteria
	*/
	async searchStorePaginated(store, namespace, options = {}) {
		const { query, filter, pageSize = 100 } = options;
		const allItems = [];
		let offset = 0;
		while (true) {
			const pageItems = await store.search(namespace, {
				query,
				filter,
				limit: pageSize,
				offset
			});
			if (!pageItems || pageItems.length === 0) break;
			allItems.push(...pageItems);
			if (pageItems.length < pageSize) break;
			offset += pageSize;
		}
		return allItems;
	}
	/**
	* List files and directories in the specified directory (non-recursive).
	*
	* @param path - Absolute path to directory
	* @returns List of FileInfo objects for files and directories directly in the directory.
	*          Directories have a trailing / in their path and is_dir=true.
	*/
	async lsInfo(path$1) {
		const store = this.getStore();
		const namespace = this.getNamespace();
		const items = await this.searchStorePaginated(store, namespace);
		const infos = [];
		const subdirs = /* @__PURE__ */ new Set();
		const normalizedPath = path$1.endsWith("/") ? path$1 : path$1 + "/";
		for (const item of items) {
			const itemKey = String(item.key);
			if (!itemKey.startsWith(normalizedPath)) continue;
			const relative = itemKey.substring(normalizedPath.length);
			if (relative.includes("/")) {
				const subdirName = relative.split("/")[0];
				subdirs.add(normalizedPath + subdirName + "/");
				continue;
			}
			try {
				const fd = this.convertStoreItemToFileData(item);
				const size = fd.content.join("\n").length;
				infos.push({
					path: itemKey,
					is_dir: false,
					size,
					modified_at: fd.modified_at
				});
			} catch {
				continue;
			}
		}
		for (const subdir of Array.from(subdirs).sort()) infos.push({
			path: subdir,
			is_dir: true,
			size: 0,
			modified_at: ""
		});
		infos.sort((a, b) => a.path.localeCompare(b.path));
		return infos;
	}
	/**
	* Read file content with line numbers.
	*
	* @param filePath - Absolute file path
	* @param offset - Line offset to start reading from (0-indexed)
	* @param limit - Maximum number of lines to read
	* @returns Formatted file content with line numbers, or error message
	*/
	async read(filePath, offset = 0, limit = 2e3) {
		try {
			return formatReadResponse(await this.readRaw(filePath), offset, limit);
		} catch (e) {
			return `Error: ${e.message}`;
		}
	}
	/**
	* Read file content as raw FileData.
	*
	* @param filePath - Absolute file path
	* @returns Raw file content as FileData
	*/
	async readRaw(filePath) {
		const store = this.getStore();
		const namespace = this.getNamespace();
		const item = await store.get(namespace, filePath);
		if (!item) throw new Error(`File '${filePath}' not found`);
		return this.convertStoreItemToFileData(item);
	}
	/**
	* Create a new file with content.
	* Returns WriteResult. External storage sets filesUpdate=null.
	*/
	async write(filePath, content) {
		const store = this.getStore();
		const namespace = this.getNamespace();
		if (await store.get(namespace, filePath)) return { error: `Cannot write to ${filePath} because it already exists. Read and then make an edit, or write to a new path.` };
		const fileData = createFileData(content);
		const storeValue = this.convertFileDataToStoreValue(fileData);
		await store.put(namespace, filePath, storeValue);
		return {
			path: filePath,
			filesUpdate: null
		};
	}
	/**
	* Edit a file by replacing string occurrences.
	* Returns EditResult. External storage sets filesUpdate=null.
	*/
	async edit(filePath, oldString, newString, replaceAll = false) {
		const store = this.getStore();
		const namespace = this.getNamespace();
		const item = await store.get(namespace, filePath);
		if (!item) return { error: `Error: File '${filePath}' not found` };
		try {
			const fileData = this.convertStoreItemToFileData(item);
			const result = performStringReplacement(fileDataToString(fileData), oldString, newString, replaceAll);
			if (typeof result === "string") return { error: result };
			const [newContent, occurrences] = result;
			const newFileData = updateFileData(fileData, newContent);
			const storeValue = this.convertFileDataToStoreValue(newFileData);
			await store.put(namespace, filePath, storeValue);
			return {
				path: filePath,
				filesUpdate: null,
				occurrences
			};
		} catch (e) {
			return { error: `Error: ${e.message}` };
		}
	}
	/**
	* Structured search results or error string for invalid input.
	*/
	async grepRaw(pattern, path$1 = "/", glob = null) {
		const store = this.getStore();
		const namespace = this.getNamespace();
		const items = await this.searchStorePaginated(store, namespace);
		const files = {};
		for (const item of items) try {
			files[item.key] = this.convertStoreItemToFileData(item);
		} catch {
			continue;
		}
		return grepMatchesFromFiles(files, pattern, path$1, glob);
	}
	/**
	* Structured glob matching returning FileInfo objects.
	*/
	async globInfo(pattern, path$1 = "/") {
		const store = this.getStore();
		const namespace = this.getNamespace();
		const items = await this.searchStorePaginated(store, namespace);
		const files = {};
		for (const item of items) try {
			files[item.key] = this.convertStoreItemToFileData(item);
		} catch {
			continue;
		}
		const result = globSearchFiles(files, pattern, path$1);
		if (result === "No files found") return [];
		const paths = result.split("\n");
		const infos = [];
		for (const p of paths) {
			const fd = files[p];
			const size = fd ? fd.content.join("\n").length : 0;
			infos.push({
				path: p,
				is_dir: false,
				size,
				modified_at: fd?.modified_at || ""
			});
		}
		return infos;
	}
};

//#endregion
//#region src/backends/filesystem.ts
const SUPPORTS_NOFOLLOW = fsSync.constants.O_NOFOLLOW !== void 0;
/**
* Backend that reads and writes files directly from the filesystem.
*
* Files are accessed using their actual filesystem paths. Relative paths are
* resolved relative to the current working directory. Content is read/written
* as plain text, and metadata (timestamps) are derived from filesystem stats.
*/
var FilesystemBackend = class {
	cwd;
	virtualMode;
	maxFileSizeBytes;
	constructor(options = {}) {
		const { rootDir, virtualMode = false, maxFileSizeMb = 10 } = options;
		this.cwd = rootDir ? path.resolve(rootDir) : process.cwd();
		this.virtualMode = virtualMode;
		this.maxFileSizeBytes = maxFileSizeMb * 1024 * 1024;
	}
	/**
	* Resolve a file path with security checks.
	*
	* When virtualMode=true, treat incoming paths as virtual absolute paths under
	* this.cwd, disallow traversal (.., ~) and ensure resolved path stays within root.
	* When virtualMode=false, preserve legacy behavior: absolute paths are allowed
	* as-is; relative paths resolve under cwd.
	*
	* @param key - File path (absolute, relative, or virtual when virtualMode=true)
	* @returns Resolved absolute path string
	* @throws Error if path traversal detected or path outside root
	*/
	resolvePath(key) {
		if (this.virtualMode) {
			const vpath = key.startsWith("/") ? key : "/" + key;
			if (vpath.includes("..") || vpath.startsWith("~")) throw new Error("Path traversal not allowed");
			const full = path.resolve(this.cwd, vpath.substring(1));
			const relative = path.relative(this.cwd, full);
			if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`Path: ${full} outside root directory: ${this.cwd}`);
			return full;
		}
		if (path.isAbsolute(key)) return key;
		return path.resolve(this.cwd, key);
	}
	/**
	* List files and directories in the specified directory (non-recursive).
	*
	* @param dirPath - Absolute directory path to list files from
	* @returns List of FileInfo objects for files and directories directly in the directory.
	*          Directories have a trailing / in their path and is_dir=true.
	*/
	async lsInfo(dirPath) {
		try {
			const resolvedPath = this.resolvePath(dirPath);
			if (!(await fs.stat(resolvedPath)).isDirectory()) return [];
			const entries = await fs.readdir(resolvedPath, { withFileTypes: true });
			const results = [];
			const cwdStr = this.cwd.endsWith(path.sep) ? this.cwd : this.cwd + path.sep;
			for (const entry of entries) {
				const fullPath = path.join(resolvedPath, entry.name);
				try {
					const entryStat = await fs.stat(fullPath);
					const isFile = entryStat.isFile();
					const isDir = entryStat.isDirectory();
					if (!this.virtualMode) {
						if (isFile) results.push({
							path: fullPath,
							is_dir: false,
							size: entryStat.size,
							modified_at: entryStat.mtime.toISOString()
						});
						else if (isDir) results.push({
							path: fullPath + path.sep,
							is_dir: true,
							size: 0,
							modified_at: entryStat.mtime.toISOString()
						});
					} else {
						let relativePath;
						if (fullPath.startsWith(cwdStr)) relativePath = fullPath.substring(cwdStr.length);
						else if (fullPath.startsWith(this.cwd)) relativePath = fullPath.substring(this.cwd.length).replace(/^[/\\]/, "");
						else relativePath = fullPath;
						relativePath = relativePath.split(path.sep).join("/");
						const virtPath = "/" + relativePath;
						if (isFile) results.push({
							path: virtPath,
							is_dir: false,
							size: entryStat.size,
							modified_at: entryStat.mtime.toISOString()
						});
						else if (isDir) results.push({
							path: virtPath + "/",
							is_dir: true,
							size: 0,
							modified_at: entryStat.mtime.toISOString()
						});
					}
				} catch {
					continue;
				}
			}
			results.sort((a, b) => a.path.localeCompare(b.path));
			return results;
		} catch {
			return [];
		}
	}
	/**
	* Read file content with line numbers.
	*
	* @param filePath - Absolute or relative file path
	* @param offset - Line offset to start reading from (0-indexed)
	* @param limit - Maximum number of lines to read
	* @returns Formatted file content with line numbers, or error message
	*/
	async read(filePath, offset = 0, limit = 2e3) {
		try {
			const resolvedPath = this.resolvePath(filePath);
			let content;
			if (SUPPORTS_NOFOLLOW) {
				if (!(await fs.stat(resolvedPath)).isFile()) return `Error: File '${filePath}' not found`;
				const fd = await fs.open(resolvedPath, fsSync.constants.O_RDONLY | fsSync.constants.O_NOFOLLOW);
				try {
					content = await fd.readFile({ encoding: "utf-8" });
				} finally {
					await fd.close();
				}
			} else {
				const stat = await fs.lstat(resolvedPath);
				if (stat.isSymbolicLink()) return `Error: Symlinks are not allowed: ${filePath}`;
				if (!stat.isFile()) return `Error: File '${filePath}' not found`;
				content = await fs.readFile(resolvedPath, "utf-8");
			}
			const emptyMsg = checkEmptyContent(content);
			if (emptyMsg) return emptyMsg;
			const lines = content.split("\n");
			const startIdx = offset;
			const endIdx = Math.min(startIdx + limit, lines.length);
			if (startIdx >= lines.length) return `Error: Line offset ${offset} exceeds file length (${lines.length} lines)`;
			return formatContentWithLineNumbers(lines.slice(startIdx, endIdx), startIdx + 1);
		} catch (e) {
			return `Error reading file '${filePath}': ${e.message}`;
		}
	}
	/**
	* Read file content as raw FileData.
	*
	* @param filePath - Absolute file path
	* @returns Raw file content as FileData
	*/
	async readRaw(filePath) {
		const resolvedPath = this.resolvePath(filePath);
		let content;
		let stat;
		if (SUPPORTS_NOFOLLOW) {
			stat = await fs.stat(resolvedPath);
			if (!stat.isFile()) throw new Error(`File '${filePath}' not found`);
			const fd = await fs.open(resolvedPath, fsSync.constants.O_RDONLY | fsSync.constants.O_NOFOLLOW);
			try {
				content = await fd.readFile({ encoding: "utf-8" });
			} finally {
				await fd.close();
			}
		} else {
			stat = await fs.lstat(resolvedPath);
			if (stat.isSymbolicLink()) throw new Error(`Symlinks are not allowed: ${filePath}`);
			if (!stat.isFile()) throw new Error(`File '${filePath}' not found`);
			content = await fs.readFile(resolvedPath, "utf-8");
		}
		return {
			content: content.split("\n"),
			created_at: stat.ctime.toISOString(),
			modified_at: stat.mtime.toISOString()
		};
	}
	/**
	* Create a new file with content.
	* Returns WriteResult. External storage sets filesUpdate=null.
	*/
	async write(filePath, content) {
		try {
			const resolvedPath = this.resolvePath(filePath);
			try {
				if ((await fs.lstat(resolvedPath)).isSymbolicLink()) return { error: `Cannot write to ${filePath} because it is a symlink. Symlinks are not allowed.` };
				return { error: `Cannot write to ${filePath} because it already exists. Read and then make an edit, or write to a new path.` };
			} catch {}
			await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
			if (SUPPORTS_NOFOLLOW) {
				const flags = fsSync.constants.O_WRONLY | fsSync.constants.O_CREAT | fsSync.constants.O_TRUNC | fsSync.constants.O_NOFOLLOW;
				const fd = await fs.open(resolvedPath, flags, 420);
				try {
					await fd.writeFile(content, "utf-8");
				} finally {
					await fd.close();
				}
			} else await fs.writeFile(resolvedPath, content, "utf-8");
			return {
				path: filePath,
				filesUpdate: null
			};
		} catch (e) {
			return { error: `Error writing file '${filePath}': ${e.message}` };
		}
	}
	/**
	* Edit a file by replacing string occurrences.
	* Returns EditResult. External storage sets filesUpdate=null.
	*/
	async edit(filePath, oldString, newString, replaceAll = false) {
		try {
			const resolvedPath = this.resolvePath(filePath);
			let content;
			if (SUPPORTS_NOFOLLOW) {
				if (!(await fs.stat(resolvedPath)).isFile()) return { error: `Error: File '${filePath}' not found` };
				const fd = await fs.open(resolvedPath, fsSync.constants.O_RDONLY | fsSync.constants.O_NOFOLLOW);
				try {
					content = await fd.readFile({ encoding: "utf-8" });
				} finally {
					await fd.close();
				}
			} else {
				const stat = await fs.lstat(resolvedPath);
				if (stat.isSymbolicLink()) return { error: `Error: Symlinks are not allowed: ${filePath}` };
				if (!stat.isFile()) return { error: `Error: File '${filePath}' not found` };
				content = await fs.readFile(resolvedPath, "utf-8");
			}
			const result = performStringReplacement(content, oldString, newString, replaceAll);
			if (typeof result === "string") return { error: result };
			const [newContent, occurrences] = result;
			if (SUPPORTS_NOFOLLOW) {
				const flags = fsSync.constants.O_WRONLY | fsSync.constants.O_TRUNC | fsSync.constants.O_NOFOLLOW;
				const fd = await fs.open(resolvedPath, flags);
				try {
					await fd.writeFile(newContent, "utf-8");
				} finally {
					await fd.close();
				}
			} else await fs.writeFile(resolvedPath, newContent, "utf-8");
			return {
				path: filePath,
				filesUpdate: null,
				occurrences
			};
		} catch (e) {
			return { error: `Error editing file '${filePath}': ${e.message}` };
		}
	}
	/**
	* Structured search results or error string for invalid input.
	*/
	async grepRaw(pattern, dirPath = "/", glob = null) {
		try {
			new RegExp(pattern);
		} catch (e) {
			return `Invalid regex pattern: ${e.message}`;
		}
		let baseFull;
		try {
			baseFull = this.resolvePath(dirPath || ".");
		} catch {
			return [];
		}
		try {
			await fs.stat(baseFull);
		} catch {
			return [];
		}
		let results = await this.ripgrepSearch(pattern, baseFull, glob);
		if (results === null) results = await this.pythonSearch(pattern, baseFull, glob);
		const matches = [];
		for (const [fpath, items] of Object.entries(results)) for (const [lineNum, lineText] of items) matches.push({
			path: fpath,
			line: lineNum,
			text: lineText
		});
		return matches;
	}
	/**
	* Try to use ripgrep for fast searching.
	* Returns null if ripgrep is not available or fails.
	*/
	async ripgrepSearch(pattern, baseFull, includeGlob) {
		return new Promise((resolve) => {
			const args = ["--json"];
			if (includeGlob) args.push("--glob", includeGlob);
			args.push("--", pattern, baseFull);
			const proc = spawn("rg", args, { timeout: 3e4 });
			const results = {};
			let output = "";
			proc.stdout.on("data", (data) => {
				output += data.toString();
			});
			proc.on("close", (code) => {
				if (code !== 0 && code !== 1) {
					resolve(null);
					return;
				}
				for (const line of output.split("\n")) {
					if (!line.trim()) continue;
					try {
						const data = JSON.parse(line);
						if (data.type !== "match") continue;
						const pdata = data.data || {};
						const ftext = pdata.path?.text;
						if (!ftext) continue;
						let virtPath;
						if (this.virtualMode) try {
							const resolved = path.resolve(ftext);
							const relative = path.relative(this.cwd, resolved);
							if (relative.startsWith("..")) continue;
							virtPath = "/" + relative.split(path.sep).join("/");
						} catch {
							continue;
						}
						else virtPath = ftext;
						const ln = pdata.line_number;
						const lt = pdata.lines?.text?.replace(/\n$/, "") || "";
						if (ln === void 0) continue;
						if (!results[virtPath]) results[virtPath] = [];
						results[virtPath].push([ln, lt]);
					} catch {
						continue;
					}
				}
				resolve(results);
			});
			proc.on("error", () => {
				resolve(null);
			});
		});
	}
	/**
	* Fallback regex search implementation.
	*/
	async pythonSearch(pattern, baseFull, includeGlob) {
		let regex;
		try {
			regex = new RegExp(pattern);
		} catch {
			return {};
		}
		const results = {};
		const files = await fg("**/*", {
			cwd: (await fs.stat(baseFull)).isDirectory() ? baseFull : path.dirname(baseFull),
			absolute: true,
			onlyFiles: true,
			dot: true
		});
		for (const fp of files) try {
			if (includeGlob && !micromatch.isMatch(path.basename(fp), includeGlob)) continue;
			if ((await fs.stat(fp)).size > this.maxFileSizeBytes) continue;
			const lines = (await fs.readFile(fp, "utf-8")).split("\n");
			for (let i = 0; i < lines.length; i++) {
				const line = lines[i];
				if (regex.test(line)) {
					let virtPath;
					if (this.virtualMode) try {
						const relative = path.relative(this.cwd, fp);
						if (relative.startsWith("..")) continue;
						virtPath = "/" + relative.split(path.sep).join("/");
					} catch {
						continue;
					}
					else virtPath = fp;
					if (!results[virtPath]) results[virtPath] = [];
					results[virtPath].push([i + 1, line]);
				}
			}
		} catch {
			continue;
		}
		return results;
	}
	/**
	* Structured glob matching returning FileInfo objects.
	*/
	async globInfo(pattern, searchPath = "/") {
		if (pattern.startsWith("/")) pattern = pattern.substring(1);
		const resolvedSearchPath = searchPath === "/" ? this.cwd : this.resolvePath(searchPath);
		try {
			if (!(await fs.stat(resolvedSearchPath)).isDirectory()) return [];
		} catch {
			return [];
		}
		const results = [];
		try {
			const matches = await fg(pattern, {
				cwd: resolvedSearchPath,
				absolute: true,
				onlyFiles: true,
				dot: true
			});
			for (const matchedPath of matches) try {
				const stat = await fs.stat(matchedPath);
				if (!stat.isFile()) continue;
				const normalizedPath = matchedPath.split("/").join(path.sep);
				if (!this.virtualMode) results.push({
					path: normalizedPath,
					is_dir: false,
					size: stat.size,
					modified_at: stat.mtime.toISOString()
				});
				else {
					const cwdStr = this.cwd.endsWith(path.sep) ? this.cwd : this.cwd + path.sep;
					let relativePath;
					if (normalizedPath.startsWith(cwdStr)) relativePath = normalizedPath.substring(cwdStr.length);
					else if (normalizedPath.startsWith(this.cwd)) relativePath = normalizedPath.substring(this.cwd.length).replace(/^[/\\]/, "");
					else relativePath = normalizedPath;
					relativePath = relativePath.split(path.sep).join("/");
					const virt = "/" + relativePath;
					results.push({
						path: virt,
						is_dir: false,
						size: stat.size,
						modified_at: stat.mtime.toISOString()
					});
				}
			} catch {
				continue;
			}
		} catch {}
		results.sort((a, b) => a.path.localeCompare(b.path));
		return results;
	}
};

//#endregion
//#region src/backends/composite.ts
/**
* Backend that routes file operations to different backends based on path prefix.
*
* This enables hybrid storage strategies like:
* - `/memories/` → StoreBackend (persistent, cross-thread)
* - Everything else → StateBackend (ephemeral, per-thread)
*
* The CompositeBackend handles path prefix stripping/re-adding transparently.
*/
var CompositeBackend = class {
	default;
	routes;
	sortedRoutes;
	constructor(defaultBackend, routes) {
		this.default = defaultBackend;
		this.routes = routes;
		this.sortedRoutes = Object.entries(routes).sort((a, b) => b[0].length - a[0].length);
	}
	/**
	* Determine which backend handles this key and strip prefix.
	*
	* @param key - Original file path
	* @returns Tuple of [backend, stripped_key] where stripped_key has the route
	*          prefix removed (but keeps leading slash).
	*/
	getBackendAndKey(key) {
		for (const [prefix, backend] of this.sortedRoutes) if (key.startsWith(prefix)) {
			const suffix = key.substring(prefix.length);
			return [backend, suffix ? "/" + suffix : "/"];
		}
		return [this.default, key];
	}
	/**
	* List files and directories in the specified directory (non-recursive).
	*
	* @param path - Absolute path to directory
	* @returns List of FileInfo objects with route prefixes added, for files and directories
	*          directly in the directory. Directories have a trailing / in their path and is_dir=true.
	*/
	async lsInfo(path$1) {
		for (const [routePrefix, backend] of this.sortedRoutes) if (path$1.startsWith(routePrefix.replace(/\/$/, ""))) {
			const suffix = path$1.substring(routePrefix.length);
			const searchPath = suffix ? "/" + suffix : "/";
			const infos = await backend.lsInfo(searchPath);
			const prefixed = [];
			for (const fi of infos) prefixed.push({
				...fi,
				path: routePrefix.slice(0, -1) + fi.path
			});
			return prefixed;
		}
		if (path$1 === "/") {
			const results = [];
			const defaultInfos = await this.default.lsInfo(path$1);
			results.push(...defaultInfos);
			for (const [routePrefix] of this.sortedRoutes) results.push({
				path: routePrefix,
				is_dir: true,
				size: 0,
				modified_at: ""
			});
			results.sort((a, b) => a.path.localeCompare(b.path));
			return results;
		}
		return await this.default.lsInfo(path$1);
	}
	/**
	* Read file content, routing to appropriate backend.
	*
	* @param filePath - Absolute file path
	* @param offset - Line offset to start reading from (0-indexed)
	* @param limit - Maximum number of lines to read
	* @returns Formatted file content with line numbers, or error message
	*/
	async read(filePath, offset = 0, limit = 2e3) {
		const [backend, strippedKey] = this.getBackendAndKey(filePath);
		return await backend.read(strippedKey, offset, limit);
	}
	/**
	* Read file content as raw FileData.
	*
	* @param filePath - Absolute file path
	* @returns Raw file content as FileData
	*/
	async readRaw(filePath) {
		const [backend, strippedKey] = this.getBackendAndKey(filePath);
		return await backend.readRaw(strippedKey);
	}
	/**
	* Structured search results or error string for invalid input.
	*/
	async grepRaw(pattern, path$1 = "/", glob = null) {
		for (const [routePrefix, backend] of this.sortedRoutes) if (path$1.startsWith(routePrefix.replace(/\/$/, ""))) {
			const searchPath = path$1.substring(routePrefix.length - 1);
			const raw = await backend.grepRaw(pattern, searchPath || "/", glob);
			if (typeof raw === "string") return raw;
			return raw.map((m) => ({
				...m,
				path: routePrefix.slice(0, -1) + m.path
			}));
		}
		const allMatches = [];
		const rawDefault = await this.default.grepRaw(pattern, path$1, glob);
		if (typeof rawDefault === "string") return rawDefault;
		allMatches.push(...rawDefault);
		for (const [routePrefix, backend] of Object.entries(this.routes)) {
			const raw = await backend.grepRaw(pattern, "/", glob);
			if (typeof raw === "string") return raw;
			allMatches.push(...raw.map((m) => ({
				...m,
				path: routePrefix.slice(0, -1) + m.path
			})));
		}
		return allMatches;
	}
	/**
	* Structured glob matching returning FileInfo objects.
	*/
	async globInfo(pattern, path$1 = "/") {
		const results = [];
		for (const [routePrefix, backend] of this.sortedRoutes) if (path$1.startsWith(routePrefix.replace(/\/$/, ""))) {
			const searchPath = path$1.substring(routePrefix.length - 1);
			return (await backend.globInfo(pattern, searchPath || "/")).map((fi) => ({
				...fi,
				path: routePrefix.slice(0, -1) + fi.path
			}));
		}
		const defaultInfos = await this.default.globInfo(pattern, path$1);
		results.push(...defaultInfos);
		for (const [routePrefix, backend] of Object.entries(this.routes)) {
			const infos = await backend.globInfo(pattern, "/");
			results.push(...infos.map((fi) => ({
				...fi,
				path: routePrefix.slice(0, -1) + fi.path
			})));
		}
		results.sort((a, b) => a.path.localeCompare(b.path));
		return results;
	}
	/**
	* Create a new file, routing to appropriate backend.
	*
	* @param filePath - Absolute file path
	* @param content - File content as string
	* @returns WriteResult with path or error
	*/
	async write(filePath, content) {
		const [backend, strippedKey] = this.getBackendAndKey(filePath);
		return await backend.write(strippedKey, content);
	}
	/**
	* Edit a file, routing to appropriate backend.
	*
	* @param filePath - Absolute file path
	* @param oldString - String to find and replace
	* @param newString - Replacement string
	* @param replaceAll - If true, replace all occurrences
	* @returns EditResult with path, occurrences, or error
	*/
	async edit(filePath, oldString, newString, replaceAll = false) {
		const [backend, strippedKey] = this.getBackendAndKey(filePath);
		return await backend.edit(strippedKey, oldString, newString, replaceAll);
	}
};

//#endregion
//#region src/agent.ts
const BASE_PROMPT = `In order to complete the objective that the user asks of you, you have access to a number of standard tools.`;
/**
* Create a Deep Agent with middleware-based architecture.
*
* Matches Python's create_deep_agent function, using middleware for all features:
* - Todo management (todoListMiddleware)
* - Filesystem tools (createFilesystemMiddleware)
* - Subagent delegation (createSubAgentMiddleware)
* - Conversation summarization (summarizationMiddleware)
* - Prompt caching (anthropicPromptCachingMiddleware)
* - Tool call patching (createPatchToolCallsMiddleware)
* - Human-in-the-loop (humanInTheLoopMiddleware) - optional
*
* @param params Configuration parameters for the agent
* @returns ReactAgent instance ready for invocation
*/
function createDeepAgent(params = {}) {
	const { model = "claude-sonnet-4-5-20250929", tools = [], systemPrompt, middleware: customMiddleware = [], subagents = [], responseFormat, contextSchema, checkpointer, store, backend, interruptOn, name } = params;
	const finalSystemPrompt = systemPrompt ? `${systemPrompt}\n\n${BASE_PROMPT}` : BASE_PROMPT;
	const filesystemBackend = backend ? backend : (config) => new StateBackend(config);
	const middleware = [
		todoListMiddleware(),
		createFilesystemMiddleware({ backend: filesystemBackend }),
		createSubAgentMiddleware({
			defaultModel: model,
			defaultTools: tools,
			defaultMiddleware: [
				todoListMiddleware(),
				createFilesystemMiddleware({ backend: filesystemBackend }),
				summarizationMiddleware({
					model,
					trigger: { tokens: 17e4 },
					keep: { messages: 6 }
				}),
				anthropicPromptCachingMiddleware({ unsupportedModelBehavior: "ignore" }),
				createPatchToolCallsMiddleware()
			],
			defaultInterruptOn: interruptOn,
			subagents,
			generalPurposeAgent: true
		}),
		summarizationMiddleware({
			model,
			trigger: { tokens: 17e4 },
			keep: { messages: 6 }
		}),
		anthropicPromptCachingMiddleware({ unsupportedModelBehavior: "ignore" }),
		createPatchToolCallsMiddleware()
	];
	if (interruptOn) middleware.push(humanInTheLoopMiddleware({ interruptOn }));
	middleware.push(...customMiddleware);
	return createAgent({
		model,
		systemPrompt: finalSystemPrompt,
		tools,
		middleware,
		responseFormat,
		contextSchema,
		checkpointer,
		store,
		name
	});
}

//#endregion
export { CompositeBackend, FilesystemBackend, StateBackend, StoreBackend, createDeepAgent, createFilesystemMiddleware, createPatchToolCallsMiddleware, createSubAgentMiddleware };