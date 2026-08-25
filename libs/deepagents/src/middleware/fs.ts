/**
 * Middleware for providing filesystem tools to an agent.
 *
 * Provides ls, read_file, write_file, edit_file, delete, glob, and grep tools with support for:
 * - Pluggable backends (StateBackend, StoreBackend, FilesystemBackend, CompositeBackend)
 * - Tool result eviction for large outputs
 */

import {
  context,
  createMiddleware,
  tool,
  HumanMessage,
  ToolMessage,
  type AgentMiddleware as _AgentMiddleware,
  type ToolRuntime,
} from "langchain";
import {
  Command,
  isCommand,
  StateSchema,
  ReducedValue,
} from "@langchain/langgraph";
import { z } from "zod/v4";
import type {
  AnyBackendProtocol,
  BackendFactory,
  BackendProtocolV2,
  BackendRuntime,
  DeleteResult,
  FileData,
  LsResult,
  ReadResult,
} from "../backends/protocol.js";
import { isSandboxBackend, resolveBackend } from "../backends/protocol.js";
import { StateBackend } from "../backends/state.js";
import {
  sanitizeToolCallId,
  formatContentWithLineNumbers,
  formatGrepMatches,
  truncateIfTooLong,
  getMimeType,
  isTextMimeType,
  MAX_LINE_LENGTH,
} from "../backends/utils.js";

const INT_FORMATTER = new Intl.NumberFormat("en-US");

/**
 * Normalizes tool input so that models sending `path` instead of `file_path`
 * still work. If the input has `path` but not `file_path`, copies `path` into
 * `file_path`. This makes the filesystem tools resilient to parameter-name
 * variations across models of different capability levels.
 */
function normalizeFilePathInput(input: unknown): unknown {
  if (
    typeof input === "object" &&
    input !== null &&
    "path" in input &&
    !("file_path" in input)
  ) {
    const { path, ...rest } = input as Record<string, unknown>;
    return { ...rest, file_path: path };
  }
  return input;
}

/**
 * Import langchain for type inference
 */
import type * as _langchain from "langchain";

/**
 * Tools that should be excluded from the large result eviction logic.
 *
 * This array contains tools that should NOT have their results evicted to the filesystem
 * when they exceed token limits. Tools are excluded for different reasons:
 *
 * 1. Tools with built-in truncation (ls, glob, grep):
 *    These tools truncate their own output when it becomes too large. When these tools
 *    produce truncated output due to many matches, it typically indicates the query
 *    needs refinement rather than full result preservation. In such cases, the truncated
 *    matches are potentially more like noise and the LLM should be prompted to narrow
 *    its search criteria instead.
 *
 * 2. Tools with problematic truncation behavior (read_file):
 *    read_file is tricky to handle as the failure mode here is single long lines
 *    (e.g., imagine a jsonl file with very long payloads on each line). If we try to
 *    truncate the result of read_file, the agent may then attempt to re-read the
 *    truncated file using read_file again, which won't help.
 *
 * 3. Tools that never exceed limits (edit_file, write_file, delete):
 *    These tools return minimal confirmation messages and are never expected to produce
 *    output large enough to exceed token limits, so checking them would be unnecessary.
 */
/**
 * All tool names registered by FilesystemMiddleware.
 * This is the single source of truth — used by createDeepAgent to detect
 * collisions with user-supplied tools at construction time.
 */
export const FILESYSTEM_TOOL_NAMES = [
  "ls",
  "read_file",
  "write_file",
  "edit_file",
  "delete",
  "glob",
  "grep",
  "execute",
] as const;

/**
 * Built-in filesystem tool names accepted by
 * {@link createFilesystemMiddleware}'s `tools` allowlist.
 */
export type FsToolName = (typeof FILESYSTEM_TOOL_NAMES)[number];

export const TOOLS_EXCLUDED_FROM_EVICTION = FILESYSTEM_TOOL_NAMES.filter(
  (name) => name !== "execute",
);

/**
 * Approximate number of characters per token for truncation calculations.
 * Using 4 chars per token as a conservative approximation (actual ratio varies by content)
 * This errs on the high side to avoid premature eviction of content that might fit.
 */
export const NUM_CHARS_PER_TOKEN = 4;

/**
 * Default values for read_file tool pagination (in lines).
 */
export const DEFAULT_READ_LINE_OFFSET = 0;
export const DEFAULT_READ_LINE_LIMIT = 100;

function remainingLinesNotice(readResult: ReadResult): string {
  const { totalLines, startLine, endLine, nextOffset } = readResult;
  if (
    startLine === undefined ||
    endLine === undefined ||
    nextOffset === undefined
  ) {
    return "";
  }

  const readCount = endLine - startLine + 1;
  const readUnit = readCount === 1 ? "line" : "lines";
  if (totalLines === undefined) {
    return `\n\n[Read ${readCount} ${readUnit} (lines ${startLine}-${endLine}). More lines remain from offset ${nextOffset}.]`;
  }
  if (endLine >= totalLines) {
    return "";
  }

  const remaining = totalLines - endLine;
  const remainingUnit = remaining === 1 ? "line" : "lines";
  return `\n\n[Read ${readCount} ${readUnit} (lines ${startLine}-${endLine} of ${totalLines} total). ${remaining} ${remainingUnit} remaining from offset ${nextOffset}.]`;
}

/**
 * Maximum size for binary (non-text) files read via read_file, in bytes.
 * Base64-encoded content is ~33% larger, so 10MB raw ≈ 13.3MB in context.
 * This keeps inline multimodal payloads within all major provider limits.
 */
export const MAX_BINARY_READ_SIZE_BYTES = 10 * 1024 * 1024;

/**
 * Template for truncation message in read_file.
 * {file_path} will be filled in at runtime.
 */
const READ_FILE_TRUNCATION_MSG = `

[Output was truncated due to size limits. The file content is very large. Consider reformatting the file to make it easier to navigate. For example, if this is JSON, use execute(command='jq . {file_path}') to pretty-print it with line breaks. For other formats, you can use appropriate formatting tools to split long lines.]`;

function truncatePaginatedRead(
  content: string,
  filePath: string,
  readResult: ReadResult,
  tokenLimit: number | null,
): string {
  const notice = remainingLinesNotice(readResult);
  if (
    !tokenLimit ||
    content.length + notice.length < NUM_CHARS_PER_TOKEN * tokenLimit
  ) {
    return content + notice;
  }

  const truncationMsg = READ_FILE_TRUNCATION_MSG.replace(
    "{file_path}",
    filePath,
  );
  const threshold = NUM_CHARS_PER_TOKEN * tokenLimit;
  if (readResult.startLine !== undefined && readResult.endLine !== undefined) {
    const rows = content.split("\n");
    const boundaries: Array<[number, number]> = [];
    let position = 0;
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      position += row.length;
      const sourceLine = Number(
        row.trimStart().split("\t", 1)[0].split(".", 1)[0],
      );
      if (!Number.isFinite(sourceLine) || sourceLine > readResult.endLine) {
        break;
      }

      const nextRow = rows[index + 1];
      const nextSourceLine = nextRow
        ? Number(nextRow.trimStart().split("\t", 1)[0].split(".", 1)[0])
        : undefined;
      if (nextSourceLine !== sourceLine) {
        boundaries.push([position, sourceLine]);
      }
      position += 1;
    }

    for (const [boundary, endLine] of boundaries.reverse()) {
      const adjustedNotice = remainingLinesNotice({
        totalLines: readResult.totalLines,
        startLine: readResult.startLine,
        endLine,
        nextOffset: endLine,
      });
      if (
        boundary + truncationMsg.length + adjustedNotice.length <=
        threshold
      ) {
        return content.slice(0, boundary) + truncationMsg + adjustedNotice;
      }
    }
  }

  return (
    content.slice(0, Math.max(0, threshold - truncationMsg.length)) +
    truncationMsg
  );
}

/**
 * Note appended to grep results that were cut short by the match-count cap.
 */
export const GREP_TRUNCATION_NOTE =
  "Note: the search stopped early because it hit the maximum match count. " +
  "The matches above are valid but incomplete. Narrow the search (a more " +
  "specific pattern or a narrower path), or raise max_count, to see the rest.";

/**
 * Default cap on the number of matches the grep tool returns.
 * Set to null to disable the cap.
 */
export const DEFAULT_GREP_MAX_COUNT = 1000;

/**
 * Message template for evicted tool results.
 */
const TOO_LARGE_TOOL_MSG = context`
  Tool result too large, the result of this tool call {tool_call_id} was saved in the filesystem at this path: {file_path}
  You can read the result from the filesystem by using the read_file tool, but make sure to only read part of the result at a time.
  You can do this by specifying an offset and limit in the read_file tool call.
  For example, to read the first ${DEFAULT_READ_LINE_LIMIT} lines, you can use the read_file tool with offset=0 and limit=${DEFAULT_READ_LINE_LIMIT}.

  Here is a preview showing the head and tail of the result (lines of the form
  ... [N lines truncated] ...
  indicate omitted lines in the middle of the content):

  {content_sample}
`;

/**
 * Message template for evicted HumanMessages.
 */
const TOO_LARGE_HUMAN_MSG = `Message content too large and was saved to the filesystem at: {file_path}

You can read the full content using the read_file tool with pagination (offset and limit parameters).

Here is a preview showing the head and tail of the content:

{content_sample}`;

/**
 * Extract text content from a message.
 *
 * For string content, returns it directly. For array content (mixed block types
 * like text + image), joins all text blocks. Returns empty string if no text found.
 */
function extractTextFromMessage(message: {
  content: string | Array<Record<string, unknown>>;
}): string {
  if (typeof message.content === "string") {
    return message.content;
  }
  if (Array.isArray(message.content)) {
    return message.content
      .filter(
        (block) => block.type === "text" && typeof block.text === "string",
      )
      .map((block) => block.text as string)
      .join("\n");
  }
  return String(message.content);
}

function stringifyToolContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (
          typeof block === "object" &&
          block !== null &&
          "type" in block &&
          block.type === "text" &&
          "text" in block &&
          typeof block.text === "string"
        ) {
          return block.text;
        }
        return JSON.stringify(block);
      })
      .join("\n");
  }
  return String(content);
}

/**
 * Build replacement content for an evicted HumanMessage, preserving non-text blocks.
 *
 * For plain string content, returns the replacement text directly. For list content
 * with mixed block types (e.g., text + image), replaces all text blocks with a single
 * text block containing the replacement text while keeping non-text blocks intact.
 */
function buildEvictedHumanContent(
  message: HumanMessage,
  replacementText: string,
): string | Array<Record<string, unknown>> {
  if (typeof message.content === "string") {
    return replacementText;
  }
  if (Array.isArray(message.content)) {
    const mediaBlocks = message.content.filter(
      (block) =>
        typeof block === "object" && block !== null && block.type !== "text",
    );
    if (mediaBlocks.length === 0) {
      return replacementText;
    }
    return [{ type: "text", text: replacementText }, ...mediaBlocks];
  }
  return replacementText;
}

/**
 * Build a truncated HumanMessage for the model request.
 *
 * Computes a preview from the full content still in state and returns a
 * lightweight replacement the model will see. Pure string computation — no
 * backend I/O.
 */
function buildTruncatedHumanMessage(
  message: HumanMessage,
  filePath: string,
): HumanMessage {
  const contentStr = extractTextFromMessage(message);
  const contentSample = createContentPreview(contentStr);
  const replacementText = TOO_LARGE_HUMAN_MSG.replace(
    "{file_path}",
    filePath,
  ).replace("{content_sample}", contentSample);
  const evictedContent = buildEvictedHumanContent(message, replacementText);
  return new HumanMessage({
    content: evictedContent as any,
    id: message.id,
    additional_kwargs: { ...message.additional_kwargs },
    response_metadata: { ...message.response_metadata },
  });
}

/**
 * Create a preview of content showing head and tail with truncation marker.
 *
 * @param contentStr - The full content string to preview.
 * @param headLines - Number of lines to show from the start (default: 5).
 * @param tailLines - Number of lines to show from the end (default: 5).
 * @returns Formatted preview string with line numbers.
 */
export function createContentPreview(
  contentStr: string,
  headLines: number = 5,
  tailLines: number = 5,
): string {
  const lines = contentStr.split("\n");

  if (lines.length <= headLines + tailLines) {
    // If file is small enough, show all lines
    const previewLines = lines.map((line) => line.substring(0, 1000));
    return formatContentWithLineNumbers(previewLines, 1);
  }

  // Show head and tail with truncation marker
  const head = lines.slice(0, headLines).map((line) => line.substring(0, 1000));
  const tail = lines.slice(-tailLines).map((line) => line.substring(0, 1000));

  const headSample = formatContentWithLineNumbers(head, 1);
  const truncationNotice = `\n... [${lines.length - headLines - tailLines} lines truncated] ...\n`;
  const tailSample = formatContentWithLineNumbers(
    tail,
    lines.length - tailLines + 1,
  );

  return headSample + truncationNotice + tailSample;
}

/**
 * required for type inference
 */
import type * as _zodTypes from "@langchain/core/utils/types";
import type * as _zodMeta from "@langchain/langgraph/zod";
import type * as _messages from "@langchain/core/messages";
import {
  FilesystemOperation,
  FilesystemPermission,
} from "../permissions/types.js";
import {
  decidePathAccess,
  globMatch,
  validatePath,
  validatePermissionPaths,
} from "../permissions/enforce.js";
import { CompositeBackend } from "../backends/composite.js";

/**
 * Zod schema for legacy FileDataV1 (content as line array).
 */
export const FileDataV1Schema = z.object({
  content: z.array(z.string()),
  created_at: z.string(),
  modified_at: z.string(),
});

/**
 * Zod schema for FileDataV2 (content as string for text or Uint8Array for binary).
 */
export const FileDataV2Schema = z.object({
  content: z.union([z.string(), z.instanceof(Uint8Array)]),
  mimeType: z.string(),
  created_at: z.string(),
  modified_at: z.string(),
});

/**
 * Zod v3 schema for FileData (re-export from backends)
 */
export const FileDataSchema = z.union([FileDataV1Schema, FileDataV2Schema]);

/**
 * Type for the files state record.
 */
export type FilesRecord = Record<string, FileData>;

/**
 * Type for file updates, where null indicates deletion.
 */
export type FilesRecordUpdate = Record<string, FileData | null>;

/**
 * Reducer for files state that merges file updates with support for deletions.
 * When a file value is null, the file is deleted from state.
 * When a file value is non-null, it is added or updated in state.
 *
 * This reducer enables concurrent updates from parallel subagents by properly
 * merging their file changes instead of requiring LastValue semantics.
 *
 * @param current - The current files record (from state)
 * @param update - The new files record (from a subagent update), with null values for deletions
 * @returns Merged files record with deletions applied
 */
export function fileDataReducer(
  current: FilesRecord | undefined,
  update: FilesRecordUpdate | undefined,
): FilesRecord {
  // If no update, return current (or empty object)
  if (update === undefined) {
    return current || {};
  }

  // If no current, filter out null values from update
  if (current === undefined) {
    const result: FilesRecord = {};
    for (const [key, value] of Object.entries(update)) {
      if (value !== null) {
        result[key] = value;
      }
    }
    return result;
  }

  // Merge: apply updates and deletions
  const result = { ...current };
  for (const [key, value] of Object.entries(update)) {
    if (value === null) {
      delete result[key];
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Shared filesystem state schema.
 * Defined at module level to ensure the same object identity is used across all agents,
 * preventing "Channel already exists with different type" errors when multiple agents
 * use createFilesystemMiddleware.
 *
 * Uses ReducedValue for files to allow concurrent updates from parallel subagents.
 */
const FilesystemStateSchema = new StateSchema({
  files: new ReducedValue(
    z.record(z.string(), FileDataSchema).default(() => ({})),
    {
      inputSchema: z.record(z.string(), FileDataSchema.nullable()).optional(),
      reducer: fileDataReducer,
    },
  ),
});

/** Extract a message string from an unknown thrown value without `instanceof`. */
function getErrorMessage(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof (error as { message?: unknown }).message === "string"
  ) {
    return (error as { message: string }).message;
  }
  return String(error);
}

/**
 * Check whether `path` is permitted under `rules` for `operation`, returning an
 * error string to surface to the model (or `undefined` when allowed).
 *
 * Never throws: an invalid path (non-absolute, or containing `..` or `~`) or a
 * denied path is a recoverable tool error, not a fatal run-ending one. Such
 * paths are rejected, never normalized, so they cannot bypass a deny rule or
 * reach the backend.
 *
 * @internal
 */
function checkPermission(
  rules: FilesystemPermission[],
  operation: FilesystemOperation,
  path: string,
): string | undefined {
  if (rules.length === 0) {
    return undefined;
  }

  let canonical: string;
  try {
    canonical = validatePath(path);
  } catch (error) {
    return `Error: ${getErrorMessage(error)}`;
  }

  if (decidePathAccess(rules, operation, canonical) === "deny") {
    return `Error: permission denied for ${operation} on ${canonical}`;
  }

  return undefined;
}

/**
 * Build an error {@link ToolMessage} for a rejected or denied path. Returning a
 * bare string would be wrapped as a `status: "success"` message whose content
 * merely starts with "Error:"; marking `status: "error"` reports the failure
 * accurately so callers and the model can distinguish a real failure from a
 * successful result.
 */
function toolError(
  runtime: ToolRuntime,
  toolName: string,
  message: string,
): ToolMessage {
  return new ToolMessage({
    content: message,
    name: toolName,
    tool_call_id: runtime.toolCall?.id as string,
    status: "error",
  });
}

const GLOB_WILDCARD_CHARACTERS = ["*", "?", "{", "["];

function hasGlobMetaCharacter(pattern: string): boolean {
  return GLOB_WILDCARD_CHARACTERS.some((character) =>
    pattern.includes(character),
  );
}

/**
 * Split an absolute POSIX path into its components (excluding the leading "/").
 * `posixParts("/a/b")` -> `["a", "b"]`; `posixParts("/")` -> `[]`.
 */
function posixParts(path: string): string[] {
  return path.split("/").filter(Boolean);
}

/**
 * Whether `child` is `ancestor` or lives (component-wise) beneath it. The root
 * `/` contains everything. `/secret` is NOT relative to `/secrets`.
 */
function isRelativeTo(child: string, ancestor: string): boolean {
  if (ancestor === "/") {
    return true;
  }
  return child === ancestor || child.startsWith(`${ancestor}/`);
}

/**
 * Return the longest leading directory of `pattern` with no wildcards.
 *
 * For a `**` suffix it returns the wildcard-free prefix, and a pattern whose
 * wildcard sits at or near the root falls back to `/`.
 */
function globAnchor(pattern: string): string {
  const safe: string[] = [];
  for (const part of posixParts(pattern)) {
    if (
      GLOB_WILDCARD_CHARACTERS.some((character) => part.includes(character))
    ) {
      break;
    }
    safe.push(part);
  }
  if (safe.length === 0) {
    return "/";
  }
  return `/${safe.join("/")}`;
}

/**
 * Whether the subtree at `callPath` intersects the subtree at `ruleAnchor`.
 * Two subtrees overlap when one is a (component-wise) prefix of the other, or
 * they are equal. The root `/` overlaps everything.
 */
function pathsOverlap(callPath: string, ruleAnchor: string): boolean {
  const a = validatePath(callPath);
  const b = validatePath(ruleAnchor);
  return a === b || isRelativeTo(a, b) || isRelativeTo(b, a);
}

/**
 * Whether a wildcard deny `pattern` overlaps a recursive delete of `target`.
 *
 * Deleting `/work/app/child` when `/work/*` is denied mutates the
 * denied `/work/app`, so it must be blocked, while `/work/*.log` can never
 * match anything under `/work/notes.txt` and stays allowed.
 */
function wildcardDeleteOverlap(
  pattern: string,
  anchor: string,
  target: string,
): boolean {
  // Root anchor ("/**/x"): pattern can match anywhere, block all.
  if (anchor === "/") {
    return true;
  }
  // Target directly matches the glob: block.
  if (globMatch(target, pattern)) {
    return true;
  }
  // Anchor is inside the delete subtree: a recursive delete would remove
  // matching descendants — block.
  if (isRelativeTo(anchor, target)) {
    return true;
  }
  // Target is below the anchor: safe to allow ONLY when the pattern suffix is a
  // single, non-** component (fixed depth) AND no ancestor of the target
  // matches the glob. Directory wildcards ("/work/*/secrets") could match
  // descendants of the target, so fail closed for those.
  if (!isRelativeTo(target, anchor)) {
    return false;
  }
  const anchorParts = posixParts(anchor);
  const patternParts = posixParts(pattern);
  const suffix = patternParts.slice(anchorParts.length);
  if (suffix.length !== 1 || suffix[0].includes("**")) {
    return true;
  }
  // Block when any ancestor of the target (between anchor and target) matches
  // the glob — the target is then inside a denied directory's subtree.
  const targetParts = posixParts(target);
  for (let depth = anchorParts.length; depth < targetParts.length; depth += 1) {
    const ancestor = `/${targetParts.slice(0, depth).join("/")}`;
    if (globMatch(ancestor, pattern)) {
      return true;
    }
  }
  return false;
}

/**
 * Resolve delete permission for a confirmed plain file: first matching write
 * rule wins, mirroring `decidePathAccess`'s ordering, but returning the matched
 * deny pattern(s) so the delete tool's error can cite them. An earlier allow
 * rule short-circuits and returns no denials.
 */
function findDeleteDenyPatternsForLeaf(
  rules: readonly FilesystemPermission[],
  target: string,
): string[] {
  for (const rule of rules) {
    if (!rule.operations.includes("write")) {
      continue;
    }
    const matched = rule.paths.filter((pattern) => globMatch(target, pattern));
    if (matched.length === 0) {
      continue;
    }
    return (rule.mode ?? "allow") === "deny" ? matched : [];
  }
  return [];
}

/**
 * Return the deny-write patterns that block deleting `target`.
 *
 * When `hasDescendants` is `true` (the target may be a directory), a recursive
 * delete removes the whole subtree, so any deny-write pattern that could match
 * `target` or anything nested under it blocks the operation regardless of rule
 * order — an earlier allow can't guarantee every descendant is safe. When
 * `hasDescendants` is `false` (a backend-confirmed plain file), the target is
 * resolved exactly like `write_file`/`edit_file`: first matching rule wins.
 *
 * @internal Exported for unit testing the delete permission overlap geometry.
 */
export function findDeleteDenyPatterns(
  rules: readonly FilesystemPermission[],
  target: string,
  hasDescendants: boolean = true,
): string[] {
  const canonicalTarget = validatePath(target);

  if (!hasDescendants) {
    return findDeleteDenyPatternsForLeaf(rules, canonicalTarget);
  }

  const denying: string[] = [];
  const seen = new Set<string>();
  for (const rule of rules) {
    if (rule.mode !== "deny" || !rule.operations.includes("write")) {
      continue;
    }
    for (const pattern of rule.paths) {
      if (seen.has(pattern)) {
        continue;
      }
      const anchor = globAnchor(pattern);
      const overlaps = hasGlobMetaCharacter(pattern)
        ? wildcardDeleteOverlap(pattern, anchor, canonicalTarget)
        : // Literal (wildcard-free) pattern: a deny on "/work" blocks deleting
          // "/work/sub" and blocks deleting an ancestor that contains it.
          pathsOverlap(canonicalTarget, anchor);
      if (overlaps) {
        seen.add(pattern);
        denying.push(pattern);
      }
    }
  }
  return denying;
}

/**
 * Whether `delete` should use the conservative recursive permission check.
 *
 * Falls back to the conservative check (returns `true`) when no permission
 * rules are configured, the backend cannot list, or the listing is ambiguous.
 * A non-empty `ls(target)` indicates descendants; a "not a directory"-style
 * error confirms a plain file. An empty, error-free listing is disambiguated
 * via the parent listing's `is_dir` flag.
 */
async function deleteTargetMayHaveDescendants(
  backend: BackendProtocolV2,
  target: string,
  permissionsConfigured: boolean,
): Promise<boolean> {
  if (!permissionsConfigured) {
    return false;
  }
  if (typeof backend.ls !== "function") {
    return true;
  }

  let lsResult: LsResult;
  try {
    lsResult = await backend.ls(target);
  } catch {
    return true;
  }
  if (lsResult.error) {
    return !lsResult.error.includes("not a directory");
  }
  if (lsResult.files && lsResult.files.length > 0) {
    return true;
  }

  // Empty, error-free listing: an exact file and an empty directory look
  // identical on flat/virtual backends. Use the parent listing's is_dir flag
  // for the target, which is consistent across backends.
  const parent = parentPath(target);
  let parentResult: LsResult;
  try {
    parentResult = await backend.ls(parent);
  } catch {
    return true;
  }
  if (parentResult.error) {
    return true;
  }
  const targetNorm = trimTrailingSlashesFs(target);
  const matches = (parentResult.files ?? []).filter(
    (entry) => trimTrailingSlashesFs(entry.path) === targetNorm,
  );
  if (matches.length === 0) {
    return true;
  }
  return matches.some((entry) => entry.is_dir === true);
}

function trimTrailingSlashesFs(path: string): string {
  let end = path.length;
  while (end > 1 && path[end - 1] === "/") end -= 1;
  return path.slice(0, end);
}

function parentPath(path: string): string {
  const parts = posixParts(path);
  if (parts.length <= 1) {
    return "/";
  }
  return `/${parts.slice(0, -1).join("/")}`;
}

function supportsDelete(backend: { delete?: unknown }): backend is {
  delete: (filePath: string) => DeleteResult | Promise<DeleteResult>;
} {
  return typeof backend.delete === "function";
}

/**
 * Filter a list of filesystem entries to those the rules permit.
 *
 * `getPath` extracts the absolute path from each entry. Entries with
 * unparsable paths are included (not silently dropped). Returns the
 * original array unchanged when `rules` is empty.
 *
 * @internal
 */
function filterByPermissions<T>(
  entries: T[],
  rules: readonly FilesystemPermission[],
  operation: FilesystemOperation,
  getPath: (entry: T) => string,
): T[] {
  if (rules.length === 0) {
    return entries;
  }

  return entries.filter((entry) => {
    try {
      const canonical = validatePath(getPath(entry));
      return decidePathAccess(rules, operation, canonical) !== "deny";
    } catch {
      return true;
    }
  });
}

export const LS_TOOL_DESCRIPTION = context`
  Lists all files in a directory.

  This is useful for exploring the filesystem and finding the right file to read or edit.
  You should almost ALWAYS use this tool before using the read_file or edit_file tools.
`;

export const READ_FILE_TOOL_DESCRIPTION = context`
  Reads a file from the filesystem. Assume any path the user provides is valid; reading a missing file returns an error.

  Usage:
  - By default, it reads up to ${DEFAULT_READ_LINE_LIMIT} lines starting from the beginning of the file. Use \`offset\`/\`limit\` to page through large files instead of reading them whole.
  - Results are returned with line numbers starting at \`offset\` + 1 (1 by default), then two spaces, then the source line. Never include these line-number prefixes when editing.
  - Lines over ${INT_FORMATTER.format(MAX_LINE_LENGTH)} characters are split with continuation markers (e.g. 5.1, 5.2); \`limit\` counts source lines, so continuation rows do not consume the budget.
  - Speculatively batch multiple \`read_file\` calls in one response when several files may be useful.
  - An empty file returns a system-reminder warning in place of contents.
  - Large tool results may be offloaded to a file; the tool message gives the path. Read that path here, paging with \`offset\`/\`limit\`.
  - Images (\`.png\`, \`.jpg\`, etc.), audio, video, and PDFs return multimodal content blocks (https://docs.langchain.com/javascript/langchain/messages#multimodal).
  - For images and PDFs, pagination via \`offset\`/\`limit\` is text-only - supply \`file_path\` only.
  - Always read a file before editing it.
`;

export const WRITE_FILE_TOOL_DESCRIPTION = context`
  Writes content to a file. Creates the file if it does not exist; replaces it entirely if it does.

  Usage:
  - Use this tool when you intend to create a new file or replace the whole file. You do not need to read the file first.
  - Prefer to edit existing files (with the edit_file tool) over creating new ones when possible.
`;

export const EDIT_FILE_TOOL_DESCRIPTION = context`
  Performs exact string replacements in files.

  Usage:
  - You must read the file before editing; this tool errors otherwise.
  - Preserve the exact indentation from the read output, and never include line-number prefixes in old_string or new_string.
  - Prefer editing an existing file over creating a new one.
  - Only use emojis if the user explicitly requests it.
`;

export const DELETE_TOOL_DESCRIPTION = context`
  Deletes a file or directory from the filesystem.

  Usage:
  - Permanently removes the file or directory at the given absolute path.
  - Deleting a directory removes it and everything inside it, recursively. Prefer
    deleting a directory in one call over deleting each file individually.
  - This cannot be undone, so only delete paths you are sure are no longer needed.
`;

export const GLOB_TOOL_DESCRIPTION = context`
  Find files matching a glob pattern, returning absolute paths.

  Supports \`*\` (any characters), \`**\` (any directories), \`?\` (single character), e.g. \`**/*.py\`, \`*.txt\`, \`/subdir/**/*.md\`.
`;

const GREP_REGEX_EXECUTE_FALLBACK =
  "\n- If you genuinely need regex, use the execute tool with `rg '<regex>'` instead.";

function getGrepToolDescription(includeExecution: boolean): string {
  const executeFallback = includeExecution ? GREP_REGEX_EXECUTE_FALLBACK : "";
  return context`
    Search for a LITERAL text pattern across files (NOT regex).

    The pattern is matched verbatim: regex metacharacters are ordinary characters, not operators. To match any of several strings, run a separate grep for each; \`grep(pattern="foo|bar")\` searches for the literal text "foo|bar", and \`.*\` or \`\\.\` match those characters literally.${executeFallback}

    Returns matching files or content per \`output_mode\`. Offloaded large tool results live under the artifacts root (\`/large_tool_results/\` by default); grep that directory to search them when you do not know the exact path.
  `;
}

const EXECUTE_SEARCH_GUIDANCE = {
  both: "You MUST avoid using search commands like find and grep. Instead use the grep, glob tools to search. ",
  grep: "You MUST avoid using shell grep for searches. Instead use the grep tool to search text. ",
  glob: "You MUST avoid using shell find for searches. Instead use the glob tool to find files. ",
  none: "",
} as const;

function getExecuteToolDescription(hasGrep: boolean, hasGlob: boolean): string {
  const searchGuidance = hasGrep
    ? hasGlob
      ? EXECUTE_SEARCH_GUIDANCE.both
      : EXECUTE_SEARCH_GUIDANCE.grep
    : hasGlob
      ? EXECUTE_SEARCH_GUIDANCE.glob
      : EXECUTE_SEARCH_GUIDANCE.none;
  const examples = [
    hasGlob
      ? "- execute(command=\"find . -name '*.py'\") # Use glob tool instead"
      : "",
    hasGrep
      ? "- execute(command=\"grep -r 'pattern' .\") # Use grep tool instead"
      : "",
  ].filter(Boolean);

  return context`
    Executes a shell command in an isolated sandbox and returns combined stdout/stderr with the exit code (truncated if very large).

    Usage:
    - Quote paths containing spaces (e.g. cd "/path/with spaces").
    - Chain commands with ';' or '&&' (use '&&' when a command depends on the previous); do not use newlines except inside quoted strings.
    - Use absolute paths and avoid \`cd\` so the working directory stays stable.
    - ${searchGuidance}Use read_file rather than cat/head/tail.${examples.length ? `\n${examples.join("\n")}` : ""}

    Only available on backends implementing SandboxBackendProtocol; otherwise it returns an error.
  `;
}

/**
 * Create ls tool using backend.
 */
function createLsTool(
  backend: AnyBackendProtocol | BackendFactory,
  options: {
    customDescription: string | undefined;
    permissions: FilesystemPermission[];
  },
) {
  const { customDescription, permissions } = options;
  return tool(
    async (input, runtime: ToolRuntime) => {
      const permissionError = checkPermission(
        permissions,
        "read",
        input.path ?? "/",
      );
      if (permissionError !== undefined) {
        return toolError(runtime, "ls", permissionError);
      }

      const resolvedBackend = await resolveBackend(backend, runtime);
      const path = input.path || "/";
      const lsResult = await resolvedBackend.ls(path);

      if (lsResult.error) {
        return `Error listing files: ${lsResult.error}`;
      }

      const infos = filterByPermissions(
        lsResult.files ?? [],
        permissions,
        "read",
        (info) => info.path,
      );

      if (infos.length === 0) {
        return `No files found in ${path}`;
      }

      // Format output
      const lines: string[] = [];
      for (const info of infos) {
        if (info.is_dir) {
          lines.push(`${info.path} (directory)`);
        } else {
          const size = info.size ? ` (${info.size} bytes)` : "";
          lines.push(`${info.path}${size}`);
        }
      }

      const result = truncateIfTooLong(lines);

      if (Array.isArray(result)) {
        return result.join("\n");
      }
      return result;
    },
    {
      name: "ls",
      description: customDescription || LS_TOOL_DESCRIPTION,
      schema: z.object({
        path: z
          .string()
          .optional()
          .default("/")
          .describe("Directory path to list (default: /)"),
      }),
    },
  );
}

/**
 * Create read_file tool using backend.
 */
function createReadFileTool(
  backend: AnyBackendProtocol | BackendFactory,
  options: {
    customDescription: string | undefined;
    toolTokenLimitBeforeEvict: number | null;
    permissions: FilesystemPermission[];
  },
) {
  const { customDescription, toolTokenLimitBeforeEvict, permissions } = options;
  return tool(
    async (input, runtime: ToolRuntime) => {
      const permissionError = checkPermission(
        permissions,
        "read",
        input.file_path,
      );
      if (permissionError !== undefined) {
        return toolError(runtime, "read_file", permissionError);
      }

      const resolvedBackend = await resolveBackend(backend, runtime);
      const {
        file_path,
        offset = DEFAULT_READ_LINE_OFFSET,
        limit = DEFAULT_READ_LINE_LIMIT,
      } = input;

      const readResult = await resolvedBackend.read(file_path, offset, limit);
      if (readResult.error) {
        return [{ type: "text", text: `Error: ${readResult.error}` }];
      }

      const mimeType = readResult.mimeType ?? getMimeType(file_path);

      if (!isTextMimeType(mimeType)) {
        const binaryContent = readResult.content;
        if (!binaryContent) {
          return [
            {
              type: "text",
              text: `Error: expected binary content for '${file_path}'`,
            },
          ];
        }

        // Content may arrive as:
        // - Uint8Array (direct read)
        // - string (already base64)
        // - plain object with numeric keys (Uint8Array lost through serialization)
        let base64Data: string;
        if (typeof binaryContent === "string") {
          base64Data = binaryContent;
        } else if (ArrayBuffer.isView(binaryContent)) {
          base64Data = Buffer.from(binaryContent).toString("base64");
        } else {
          const values = Object.values(binaryContent as Record<string, number>);
          base64Data = Buffer.from(new Uint8Array(values)).toString("base64");
        }

        const sizeBytes = Math.ceil((base64Data.length * 3) / 4);

        if (sizeBytes > MAX_BINARY_READ_SIZE_BYTES) {
          return [
            {
              type: "text",
              text: `Error: file too large to read (${Math.round(sizeBytes / (1024 * 1024))}MB exceeds ${MAX_BINARY_READ_SIZE_BYTES / (1024 * 1024)}MB limit for binary files)`,
            },
          ];
        }

        if (mimeType.startsWith("image/")) {
          return [{ type: "image", mimeType, data: base64Data }];
        }
        if (mimeType.startsWith("audio/")) {
          return [{ type: "audio", mimeType, data: base64Data }];
        }
        if (mimeType.startsWith("video/")) {
          return [{ type: "video", mimeType, data: base64Data }];
        }
        return [{ type: "file", mimeType, data: base64Data }];
      }

      let content =
        typeof readResult.content === "string" ? readResult.content : "";

      // Enforce line limit on result (in case backend returns more)
      const lines = content.split("\n");
      if (lines.length > limit) {
        content = lines.slice(0, limit).join("\n");
      }

      const formatted = formatContentWithLineNumbers(
        content,
        readResult.startLine ?? offset + 1,
      );

      return [
        {
          type: "text",
          text: truncatePaginatedRead(
            formatted,
            file_path,
            readResult,
            toolTokenLimitBeforeEvict,
          ),
        },
      ];
    },
    {
      name: "read_file",
      description: customDescription || READ_FILE_TOOL_DESCRIPTION,
      schema: z.preprocess(
        normalizeFilePathInput,
        z.object({
          file_path: z.string().describe("Absolute path to the file to read"),
          offset: z.coerce
            .number()
            .optional()
            .default(DEFAULT_READ_LINE_OFFSET)
            .describe("Line offset to start reading from (0-indexed)"),
          limit: z.coerce
            .number()
            .optional()
            .default(DEFAULT_READ_LINE_LIMIT)
            .describe("Maximum number of lines to read"),
        }),
      ),
    },
  );
}

/**
 * Create write_file tool using backend.
 */
function createWriteFileTool(
  backend: AnyBackendProtocol | BackendFactory,
  options: {
    customDescription: string | undefined;
    permissions: FilesystemPermission[];
  },
) {
  const { customDescription, permissions } = options;
  return tool(
    async (input, runtime: ToolRuntime) => {
      const permissionError = checkPermission(
        permissions,
        "write",
        input.file_path,
      );
      if (permissionError !== undefined) {
        return toolError(runtime, "write_file", permissionError);
      }

      const resolvedBackend = await resolveBackend(backend, runtime);
      const { file_path, content } = input;
      const result = await resolvedBackend.write(file_path, content);

      if (result.error) {
        return result.error;
      }

      // If filesUpdate is present, return Command to update state
      const message = new ToolMessage({
        content: `Successfully wrote to '${file_path}'`,
        tool_call_id: runtime.toolCall?.id as string,
        name: "write_file",
        metadata: result.metadata,
      });

      if (result.filesUpdate) {
        return new Command({
          update: { files: result.filesUpdate, messages: [message] },
        });
      }

      return message;
    },
    {
      name: "write_file",
      description: customDescription || WRITE_FILE_TOOL_DESCRIPTION,
      schema: z.preprocess(
        normalizeFilePathInput,
        z.object({
          file_path: z
            .string()
            .describe(
              "Absolute path where the file should be written. Must be absolute, not relative.",
            ),
          content: z
            .string()
            .describe(
              "The text content to write to the file. This parameter is required.",
            ),
        }),
      ),
    },
  );
}

/**
 * Create edit_file tool using backend.
 */
function createEditFileTool(
  backend: AnyBackendProtocol | BackendFactory,
  options: {
    customDescription: string | undefined;
    permissions: FilesystemPermission[];
  },
) {
  const { customDescription, permissions } = options;
  return tool(
    async (input, runtime: ToolRuntime) => {
      const permissionError = checkPermission(
        permissions,
        "write",
        input.file_path,
      );
      if (permissionError !== undefined) {
        return toolError(runtime, "edit_file", permissionError);
      }

      const resolvedBackend = await resolveBackend(backend, runtime);
      const { file_path, old_string, new_string, replace_all = false } = input;
      const result = await resolvedBackend.edit(
        file_path,
        old_string,
        new_string,
        replace_all,
      );

      if (result.error) {
        return result.error;
      }

      const message = new ToolMessage({
        content: `Successfully replaced ${result.occurrences} occurrence(s) in '${file_path}'`,
        tool_call_id: runtime.toolCall?.id as string,
        name: "edit_file",
        metadata: result.metadata,
      });

      // If filesUpdate is present, return Command to update state
      if (result.filesUpdate) {
        return new Command({
          update: { files: result.filesUpdate, messages: [message] },
        });
      }

      // External storage (filesUpdate is null)
      return message;
    },
    {
      name: "edit_file",
      description: customDescription || EDIT_FILE_TOOL_DESCRIPTION,
      schema: z.preprocess(
        normalizeFilePathInput,
        z.object({
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
      ),
    },
  );
}

/**
 * Create delete tool using backend.
 */
function createDeleteTool(
  backend: AnyBackendProtocol | BackendFactory,
  options: {
    customDescription: string | undefined;
    permissions: FilesystemPermission[];
  },
) {
  const { customDescription, permissions } = options;
  return tool(
    async (input, runtime: ToolRuntime) => {
      let validatedPath: string;
      try {
        validatedPath = validatePath(input.file_path);
      } catch (error) {
        return toolError(runtime, "delete", `Error: ${getErrorMessage(error)}`);
      }

      const resolvedBackend = await resolveBackend(backend, runtime);

      // A recursive delete removes the target and everything under it, so
      // permission is evaluated as a whole-subtree write. Probe the backend to
      // learn whether the target is a plain file (leaf) or may have
      // descendants; a confirmed leaf is resolved with first-match-wins
      // semantics (an earlier allow beats a later deny), while a possible
      // subtree blocks on any overlapping deny-write pattern regardless of
      // rule order. This drives all delete permission gating — write_file's
      // single-path checkPermission is insufficient for a recursive removal.
      const hasDescendants = await deleteTargetMayHaveDescendants(
        resolvedBackend,
        validatedPath,
        permissions.length > 0,
      );
      const denyingPatterns = findDeleteDenyPatterns(
        permissions,
        validatedPath,
        hasDescendants,
      );
      if (denyingPatterns.length > 0) {
        return toolError(
          runtime,
          "delete",
          `Error: permission denied for write on ${validatedPath} (matches deny rule(s): ${denyingPatterns.join(", ")})`,
        );
      }

      if (!supportsDelete(resolvedBackend)) {
        return toolError(
          runtime,
          "delete",
          `Error: deletion is not available for '${validatedPath}'.`,
        );
      }

      const result: DeleteResult = await resolvedBackend.delete(validatedPath);
      if (result.error) {
        return toolError(runtime, "delete", result.error);
      }

      const message = new ToolMessage({
        content: `Deleted ${result.path ?? validatedPath}`,
        tool_call_id: runtime.toolCall?.id as string,
        name: "delete",
        metadata: result.metadata,
      });

      if (result.filesUpdate) {
        return new Command({
          update: { files: result.filesUpdate, messages: [message] },
        });
      }

      return message;
    },
    {
      name: "delete",
      description: customDescription || DELETE_TOOL_DESCRIPTION,
      schema: z.preprocess(
        normalizeFilePathInput,
        z.object({
          file_path: z
            .string()
            .describe(
              "Absolute path to the file to delete. Must be absolute, not relative.",
            ),
        }),
      ),
    },
  );
}

/**
 * Create glob tool using backend.
 */
function createGlobTool(
  backend: AnyBackendProtocol | BackendFactory,
  options: {
    customDescription: string | undefined;
    permissions: FilesystemPermission[];
  },
) {
  const { customDescription, permissions } = options;
  return tool(
    async (input, runtime: ToolRuntime) => {
      const permissionError = checkPermission(
        permissions,
        "read",
        input.path ?? "/",
      );
      if (permissionError !== undefined) {
        return toolError(runtime, "glob", permissionError);
      }

      const resolvedBackend = await resolveBackend(backend, runtime);
      const { pattern, path } = input;
      const globResult = await resolvedBackend.glob(pattern, path);

      if (globResult.error) {
        return `Error finding files: ${globResult.error}`;
      }

      const infos = filterByPermissions(
        globResult.files ?? [],
        permissions,
        "read",
        (info) => info.path,
      );

      if (infos.length === 0) {
        return `No files found matching pattern '${pattern}'`;
      }

      const paths = infos.map((info) => info.path);
      const result = truncateIfTooLong(paths);

      if (Array.isArray(result)) {
        return result.join("\n");
      }
      return result;
    },
    {
      name: "glob",
      description: customDescription || GLOB_TOOL_DESCRIPTION,
      schema: z.object({
        pattern: z
          .string()
          .describe(
            "Glob pattern to match files (e.g., '**/*.py', '*.txt', '/subdir/**/*.md')",
          ),
        path: z
          .string()
          .optional()
          .describe(
            "Base directory to search from. Defaults to the backend's default root.",
          ),
      }),
    },
  );
}

/**
 * Create grep tool using backend.
 */
function createGrepTool(
  backend: AnyBackendProtocol | BackendFactory,
  options: {
    customDescription: string | undefined;
    permissions: FilesystemPermission[];
    includeExecution: boolean;
    grepMaxCount: number | null;
  },
) {
  const { customDescription, permissions, includeExecution, grepMaxCount } =
    options;
  return tool(
    async (input, runtime: ToolRuntime) => {
      const permissionError = checkPermission(
        permissions,
        "read",
        input.path ?? "/",
      );
      if (permissionError !== undefined) {
        return toolError(runtime, "grep", permissionError);
      }

      const resolvedBackend = await resolveBackend(backend, runtime);
      const {
        pattern,
        path = "/",
        glob = null,
        output_mode = "content",
      } = input;
      // A per-call max_count overrides the configured middleware default.
      const maxCount = input.max_count ?? grepMaxCount;
      const result = await resolvedBackend.grep(pattern, path, glob, maxCount);

      // If string, it's an error
      if (result.error) {
        return result.error;
      }

      const matches = filterByPermissions(
        result.matches ?? [],
        permissions,
        "read",
        (m) => m.path,
      );

      if (matches.length === 0) {
        return `No matches found for pattern '${pattern}'`;
      }

      const formatted = formatGrepMatches(matches, output_mode);
      const truncated = truncateIfTooLong(formatted);
      let content =
        typeof truncated === "string" ? truncated : truncated.join("\n");

      if (result.truncated) {
        content += `\n\n${GREP_TRUNCATION_NOTE}`;
      }
      return content;
    },
    {
      name: "grep",
      description:
        customDescription || getGrepToolDescription(includeExecution),
      schema: z.object({
        pattern: z
          .string()
          .describe("Literal text pattern to search for (not regex)"),
        path: z
          .string()
          .optional()
          .default("/")
          .describe("Base path to search from (default: /)"),
        glob: z
          .string()
          .optional()
          .nullable()
          .default(null)
          .describe("Optional glob pattern to filter files (e.g., '*.py')"),
        max_count: z.coerce
          .number()
          .int()
          .positive()
          .optional()
          .nullable()
          .default(null)
          .describe(
            "Optional cap on the total number of matches returned across all files. " +
              "Leave unset to use the configured default. When the cap is hit, results " +
              "are truncated and a note says so; narrow the pattern or path to see the rest.",
          ),
        output_mode: z
          .enum(["files_with_matches", "content", "count"])
          .optional()
          .default("content")
          .describe(
            "Output format: 'files_with_matches' lists matching file paths, 'content' shows matching lines (default), 'count' shows match counts per file",
          ),
      }),
    },
  );
}

/**
 * Create execute tool using backend.
 */
function createExecuteTool(
  backend: AnyBackendProtocol | BackendFactory,
  options: {
    customDescription: string | undefined;
    permissions: FilesystemPermission[];
    hasGrep: boolean;
    hasGlob: boolean;
  },
) {
  const { customDescription, permissions, hasGrep, hasGlob } = options;
  return tool(
    async (input, runtime: ToolRuntime) => {
      const resolvedBackend = await resolveBackend(backend, runtime);

      // Runtime check - fail gracefully if not supported
      if (!isSandboxBackend(resolvedBackend)) {
        return (
          "Error: Execution not available. This agent's backend " +
          "does not support command execution (SandboxBackendProtocol). " +
          "To use the execute tool, provide a backend that implements SandboxBackendProtocol."
        );
      }

      // Guard against factory-backed sandbox backends used with permissions.
      // The startup check skips factory backends since they can't be resolved
      // at configuration time — this catches that case at invocation.
      if (
        permissions.length > 0 &&
        !allPathsScopedToRoutes(permissions, resolvedBackend)
      ) {
        return (
          "Error: Execution not available. Filesystem permissions cannot be " +
          "used with a backend that supports command execution because shell " +
          "commands can access any path, making path-based rules ineffective."
        );
      }

      const result = await resolvedBackend.execute(input.command);

      // Format output for LLM consumption
      const parts = [result.output];

      if (result.exitCode !== null) {
        const status = result.exitCode === 0 ? "succeeded" : "failed";
        parts.push(`\n[Command ${status} with exit code ${result.exitCode}]`);
      }

      if (result.truncated) {
        parts.push("\n[Output was truncated due to size limits]");
      }

      return parts.join("");
    },
    {
      name: "execute",
      description:
        customDescription || getExecuteToolDescription(hasGrep, hasGlob),
      schema: z.object({
        command: z.string().describe("The shell command to execute"),
      }),
    },
  );
}

/**
 * Options for creating filesystem middleware.
 */
export interface FilesystemMiddlewareOptions {
  /** Backend instance or factory (default: StateBackend) */
  backend?: AnyBackendProtocol | BackendFactory;
  /** Optional filesystem-specific usage guidance. Omitted by default because tool schemas provide it. */
  systemPrompt?: string | null;
  /**
   * Optional descriptions for built-in filesystem tools.
   *
   * Keys correspond to {@link FsToolName}. Descriptions for tools that are not
   * enabled by the `tools` allowlist are ignored because those tools are not
   * exposed to the model.
   */
  customToolDescriptions?: Partial<Record<FsToolName, string>> | null;
  /**
   * Allowlist of built-in filesystem tools to expose to the model.
   *
   * - `undefined`, `null`, and `"all"` preserve the default behavior: every
   *   filesystem tool is registered, subject to backend capability filtering.
   * - Passing an array restricts the middleware to only those tool names.
   * - `read_file` must be included in every explicit array because it is used
   *   by normal file-inspection flows and by large-result recovery guidance.
   * - Backend capability checks still narrow the final visible tool set. For
   *   example, `execute` is removed when the resolved backend does not support
   *   command execution, even if it appears in this allowlist.
   * - User-provided non-filesystem tools are not affected by this allowlist.
   *
   *
   * @example Read/search-only filesystem access
   * ```ts
   * createFilesystemMiddleware({
   *   tools: ["read_file", "ls", "glob", "grep"],
   * });
   * ```
   */
  tools?: readonly FsToolName[] | "all" | null;
  /** Optional token limit before evicting a tool result to the filesystem (default: 20000 tokens, ~80KB) */
  toolTokenLimitBeforeEvict?: number | null;
  /** Optional token limit before evicting a HumanMessage to the filesystem (default: 50000 tokens, ~200KB) */
  humanMessageTokenLimitBeforeEvict?: number | null;
  /**
   * Filesystem permission rules enforced on every tool call.
   *
   * Rules are evaluated in declaration order; first match wins; permissive
   * default. Applies to `ls`, `read_file`, `write_file`, `edit_file`,
   * `glob`, and `grep`.
   *
   * **Note on `execute`**: permissions are not enforced on `execute` because
   * shell commands can access any path regardless of path-based rules. Using
   * permissions with an execution-capable backend (one where `isSandboxBackend`
   * returns `true`) throws a `ConfigurationError` unless either:
   *
   * - `execute` is disabled via `tools`, or
   * - the backend is a `CompositeBackend` and every permission path is scoped to
   *   a route prefix.
   *
   * When omitted or empty, all filesystem operations are permitted.
   */
  permissions?: FilesystemPermission[];
  /**
   * Default cap on the number of matches the grep tool returns (default: 1000).
   *
   * When the cap is hit, the returned matches are flagged as truncated and a
   * note tells the model to narrow the search. A per-call `max_count` tool
   * argument overrides this default. Set to `null` to disable the cap.
   */
  grepMaxCount?: number | null;
}

/**
 * Returns true only when backend exposes route prefixes (CompositeBackend) and
 * every permission path is scoped under one of them.
 */
function normalizeFilesystemTools(
  tools: readonly FsToolName[] | "all" | null | undefined,
): ReadonlySet<FsToolName> | null {
  if (tools == null || tools === "all") {
    return null;
  }

  const enabledTools = new Set(tools);
  if (!enabledTools.has("read_file")) {
    throw new Error(
      "read_file must be included in tools; it is required by FilesystemMiddleware",
    );
  }

  return enabledTools;
}

function allPathsScopedToRoutes(
  permissions: FilesystemPermission[],
  backend: AnyBackendProtocol,
): boolean {
  if (!CompositeBackend.isInstance(backend)) {
    return false;
  }

  const prefixes = backend.routePrefixes;
  if (prefixes.length === 0) {
    return false;
  }

  return permissions.every((rule) =>
    rule.paths.every((path) =>
      prefixes.some((prefix) => {
        const normalizedRoute = prefix.endsWith("/") ? prefix : `${prefix}/`;
        const routeRoot = normalizedRoute.slice(0, -1);
        return path === routeRoot || path.startsWith(normalizedRoute);
      }),
    ),
  );
}

/**
 * Create middleware that provides built-in filesystem tools and optional custom
 * prompt guidance.
 *
 * By default, the middleware registers every built-in filesystem tool listed in
 * {@link FILESYSTEM_TOOL_NAMES}. Use {@link FilesystemMiddlewareOptions.tools}
 * to narrow that set for read-only, search-only, or otherwise restricted
 * agents. The allowlist only controls built-in filesystem tools; custom tools
 * from the agent or other middleware are left untouched.
 *
 * The middleware also filters tools whose backend capabilities are unavailable
 * at request time. In particular, `execute` is only visible when the resolved
 * backend supports command execution.
 *
 * @param options Filesystem middleware configuration.
 * @returns Agent middleware that contributes filesystem state, tools, prompt
 * guidance, permission checks, and large-result eviction.
 *
 * @example Read-only filesystem middleware
 * ```ts
 * const middleware = createFilesystemMiddleware({
 *   tools: ["read_file", "ls", "glob", "grep"],
 * });
 * ```
 */
export function createFilesystemMiddleware(
  options: FilesystemMiddlewareOptions = {},
) {
  const {
    backend = (runtime: BackendRuntime) => new StateBackend(runtime),
    systemPrompt: customSystemPrompt = null,
    customToolDescriptions = null,
    toolTokenLimitBeforeEvict = 20000,
    humanMessageTokenLimitBeforeEvict = 50000,
    permissions = [],
    tools: filesystemTools = null,
    grepMaxCount = DEFAULT_GREP_MAX_COUNT,
  } = options;
  const enabledFilesystemTools = normalizeFilesystemTools(filesystemTools);
  const executeToolEnabled =
    enabledFilesystemTools == null || enabledFilesystemTools.has("execute");

  if (permissions.length > 0) {
    validatePermissionPaths(permissions);
  }

  if (
    permissions.length > 0 &&
    executeToolEnabled &&
    typeof backend !== "function" &&
    isSandboxBackend(backend) &&
    !allPathsScopedToRoutes(permissions, backend)
  ) {
    throw new Error(
      "Filesystem permissions cannot be used with a backend that supports command " +
        "execution. Shell commands can access any path, making path-based rules " +
        "ineffective. Either remove permissions, use a backend without execution " +
        "support, or use a CompositeBackend with all permission paths scoped to a " +
        "route prefix.",
    );
  }

  const baseSystemPrompt = customSystemPrompt ?? null;
  const configuredToolNames =
    enabledFilesystemTools ?? new Set<FsToolName>(FILESYSTEM_TOOL_NAMES);

  /**
   * All tools including execute
   * (execute will be filtered at runtime if backend doesn't support it)
   */
  const allToolsByName = {
    ls: createLsTool(backend, {
      customDescription: customToolDescriptions?.ls,
      permissions,
    }),
    read_file: createReadFileTool(backend, {
      customDescription: customToolDescriptions?.read_file,
      toolTokenLimitBeforeEvict,
      permissions,
    }),
    write_file: createWriteFileTool(backend, {
      customDescription: customToolDescriptions?.write_file,
      permissions,
    }),
    edit_file: createEditFileTool(backend, {
      customDescription: customToolDescriptions?.edit_file,
      permissions,
    }),
    delete: createDeleteTool(backend, {
      customDescription: customToolDescriptions?.delete,
      permissions,
    }),
    glob: createGlobTool(backend, {
      customDescription: customToolDescriptions?.glob,
      permissions,
    }),
    grep: createGrepTool(backend, {
      customDescription: customToolDescriptions?.grep,
      permissions,
      includeExecution:
        configuredToolNames.has("execute") &&
        typeof backend !== "function" &&
        isSandboxBackend(backend),
      grepMaxCount,
    }),
    execute: createExecuteTool(backend, {
      customDescription: customToolDescriptions?.execute,
      permissions,
      hasGrep: configuredToolNames.has("grep"),
      hasGlob: configuredToolNames.has("glob"),
    }),
  } satisfies Record<FsToolName, unknown>;
  const allTools = FILESYSTEM_TOOL_NAMES.filter(
    (name) =>
      enabledFilesystemTools == null || enabledFilesystemTools.has(name),
  ).map((name) => allToolsByName[name]);
  // Retain the built-in delete tool instance so backend-capability filtering
  // removes only this middleware's own tool, never an unrelated caller-supplied
  // tool that happens to be named "delete".
  const builtInDeleteTool = allToolsByName.delete;

  async function processToolMessage(
    msg: ToolMessage,
    runtime: Record<string, unknown> | undefined,
    state: Record<string, unknown>,
    fallbackToolCallId?: string,
  ) {
    if (!toolTokenLimitBeforeEvict) {
      return { message: msg, filesUpdate: null };
    }

    if (
      msg.name &&
      TOOLS_EXCLUDED_FROM_EVICTION.includes(
        msg.name as (typeof TOOLS_EXCLUDED_FROM_EVICTION)[number],
      )
    ) {
      return { message: msg, filesUpdate: null };
    }

    const textContent = stringifyToolContent(msg.content);
    if (textContent.length <= toolTokenLimitBeforeEvict * NUM_CHARS_PER_TOKEN) {
      return { message: msg, filesUpdate: null };
    }

    const resolvedBackend = await resolveBackend(backend, {
      ...runtime,
      state,
    });
    const sanitizedId = sanitizeToolCallId(
      fallbackToolCallId || msg.tool_call_id,
    );
    const evictPath = `/large_tool_results/${sanitizedId}.txt`;

    const writeResult = await resolvedBackend.write(evictPath, textContent);

    const contentSample = createContentPreview(textContent);
    const replacementText = writeResult.error
      ? `Tool result too large, but the result could not be saved to the filesystem: ${writeResult.error}`
      : TOO_LARGE_TOOL_MSG.replace("{tool_call_id}", msg.tool_call_id)
          .replace("{file_path}", evictPath)
          .replace("{content_sample}", contentSample);

    const truncatedMessage = new ToolMessage({
      content: replacementText,
      tool_call_id: msg.tool_call_id,
      name: msg.name,
      id: msg.id,
      artifact: msg.artifact,
      status: msg.status,
      metadata: msg.metadata,
      additional_kwargs: msg.additional_kwargs,
      response_metadata: msg.response_metadata,
    });

    return {
      message: truncatedMessage,
      filesUpdate: writeResult.error ? null : writeResult.filesUpdate,
    };
  }

  return createMiddleware({
    name: "FilesystemMiddleware",
    stateSchema: FilesystemStateSchema,
    tools: allTools,
    async beforeAgent(state) {
      if (!humanMessageTokenLimitBeforeEvict) {
        return undefined;
      }

      const messages = state.messages;
      if (!messages || messages.length === 0) {
        return undefined;
      }

      const last = messages[messages.length - 1];
      if (!HumanMessage.isInstance(last)) {
        return undefined;
      }

      if (last.additional_kwargs?.lc_evicted_to) {
        return undefined;
      }

      const contentStr = extractTextFromMessage(last);
      const threshold = NUM_CHARS_PER_TOKEN * humanMessageTokenLimitBeforeEvict;
      if (contentStr.length <= threshold) {
        return undefined;
      }

      const resolvedBackend = await resolveBackend(backend, {
        state: state || {},
      } as BackendRuntime);

      const fileId = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
      const filePath = `/conversation_history/${fileId}`;
      const writeResult = await resolvedBackend.write(filePath, contentStr);

      if (writeResult.error) {
        return undefined;
      }

      const taggedMessage = new HumanMessage({
        content: last.content as any,
        id: last.id,
        additional_kwargs: {
          ...last.additional_kwargs,
          lc_evicted_to: filePath,
        },
        response_metadata: { ...last.response_metadata },
      });

      const result: Record<string, unknown> = {
        messages: [taggedMessage],
      };
      if (writeResult.filesUpdate) {
        result.files = writeResult.filesUpdate;
      }
      return result;
    },
    wrapModelCall: async (request, handler) => {
      // Check if backend supports execution
      const resolvedBackend = await resolveBackend(backend, {
        ...request.runtime,
        state: request.state,
      });
      const supportsExecution = isSandboxBackend(resolvedBackend);
      const backendSupportsDelete = supportsDelete(resolvedBackend);

      // Filter tools based on backend capabilities. Execution is filtered by
      // name, but delete is filtered by instance identity so that only this
      // middleware's built-in delete tool is removed when the backend cannot
      // delete — an unrelated caller-supplied tool named "delete" is untouched.
      let tools = request.tools;
      if (!supportsExecution || !backendSupportsDelete) {
        tools = tools.filter(
          (t: { name: string }) =>
            (supportsExecution || t.name !== "execute") &&
            (backendSupportsDelete || t !== builtInDeleteTool),
        );
      }

      // Tool schemas carry the built-in usage guidance. Preserve only explicit
      // caller guidance, rather than adding a redundant filesystem prompt.
      const newSystemMessage = baseSystemPrompt
        ? request.systemMessage.concat(baseSystemPrompt)
        : request.systemMessage;

      let messages = request.messages;
      if (humanMessageTokenLimitBeforeEvict && messages) {
        const hasTagged = messages.some(
          (msg: any) =>
            HumanMessage.isInstance(msg) &&
            msg.additional_kwargs?.lc_evicted_to,
        );
        if (hasTagged) {
          messages = messages.map((msg: any) => {
            if (
              HumanMessage.isInstance(msg) &&
              msg.additional_kwargs?.lc_evicted_to
            ) {
              return buildTruncatedHumanMessage(
                msg,
                msg.additional_kwargs.lc_evicted_to as string,
              );
            }
            return msg;
          });
        }
      }

      return handler({
        ...request,
        tools,
        messages,
        systemMessage: newSystemMessage,
      });
    },
    wrapToolCall: async (request, handler) => {
      // Return early if eviction is disabled
      if (!toolTokenLimitBeforeEvict) {
        return handler(request);
      }

      // Check if this tool is excluded from eviction
      const toolName = request.toolCall?.name;
      if (
        toolName &&
        TOOLS_EXCLUDED_FROM_EVICTION.includes(
          toolName as (typeof TOOLS_EXCLUDED_FROM_EVICTION)[number],
        )
      ) {
        return handler(request);
      }

      const result = await handler(request);

      if (ToolMessage.isInstance(result)) {
        const processed = await processToolMessage(
          result,
          request.runtime,
          request.state,
          request.toolCall?.id,
        );

        if (processed.filesUpdate) {
          return new Command({
            update: {
              files: processed.filesUpdate,
              messages: [processed.message],
            },
          });
        }

        return processed.message;
      }

      if (isCommand(result)) {
        const update = result.update as any;
        if (!update?.messages) {
          return result;
        }

        let hasLargeResults = false;
        const accumulatedFiles: Record<string, FileData> = update.files
          ? { ...update.files }
          : {};
        const processedMessages: ToolMessage[] = [];

        for (const msg of update.messages) {
          if (ToolMessage.isInstance(msg)) {
            const processed = await processToolMessage(
              msg,
              request.runtime,
              request.state,
              request.toolCall?.id,
            );
            processedMessages.push(processed.message);

            if (processed.filesUpdate) {
              hasLargeResults = true;
              Object.assign(accumulatedFiles, processed.filesUpdate);
            }
          } else {
            processedMessages.push(msg);
          }
        }

        if (hasLargeResults) {
          return new Command({
            update: {
              ...update,
              messages: processedMessages,
              files: accumulatedFiles,
            },
          });
        }
      }

      return result;
    },
  });
}
