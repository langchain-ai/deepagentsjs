/**
 * Backend-agnostic skills middleware for loading agent skills from any backend.
 *
 * This middleware implements Anthropic's agent skills pattern with progressive disclosure,
 * loading skills from backend storage via configurable sources.
 *
 * ## Architecture
 *
 * Skills are loaded from one or more **sources** - paths in a backend where skills are
 * organized. Sources are loaded in order, with later sources overriding earlier ones
 * when skills have the same name (last one wins). This enables layering: base -> user
 * -> project -> team skills.
 *
 * The middleware uses backend APIs exclusively (no direct filesystem access), making it
 * portable across different storage backends (filesystem, state, remote storage, etc.).
 *
 * ## Usage
 *
 * ```typescript
 * import { createSkillsMiddleware, FilesystemBackend } from "@anthropic/deepagents";
 *
 * const middleware = createSkillsMiddleware({
 *   backend: new FilesystemBackend({ rootDir: "/" }),
 *   sources: [
 *     "/skills/user/",      // parent dir: every subdir with SKILL.md is loaded
 *     "/skills/project/",   // parent dir: every subdir with SKILL.md is loaded
 *     "/skills/my-skill/",  // direct path: SKILL.md lives at the root of this dir
 *   ],
 * });
 *
 * const agent = createDeepAgent({ middleware: [middleware] });
 * ```
 *
 * Or use the `skills` parameter on createDeepAgent:
 *
 * ```typescript
 * const agent = createDeepAgent({
 *   skills: ["/skills/user/", "/skills/project/", "/skills/my-skill/"],
 * });
 * ```
 */

import { z } from "zod";
import yaml from "yaml";
import {
  context,
  createMiddleware,
  type ModelRequest,
  type Runtime,
  /**
   * required for type inference
   */
  type AgentMiddleware as _AgentMiddleware,
} from "langchain";
import { Command, StateSchema } from "@langchain/langgraph";
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { Runnable, RunnableBinding } from "@langchain/core/runnables";
import type { ClientTool, ServerTool } from "@langchain/core/tools";
import { convertToOpenAITool } from "@langchain/core/utils/function_calling";
import { toJsonSchema } from "@langchain/core/utils/json_schema";
import { isInteropZodSchema } from "@langchain/core/utils/types";

import type {
  AnyBackendProtocol,
  BackendFactory,
  BackendProtocolV2,
} from "../backends/protocol.js";
import { resolveBackend } from "../backends/protocol.js";
import type { StateBackend } from "../backends/state.js";
import type { BaseStore } from "@langchain/langgraph-checkpoint";
import { filesValue } from "../values.js";
import { adaptBackendProtocol } from "../backends/utils.js";
import { ConfigurationError } from "../errors.js";
import { DEFAULT_READ_LINE_LIMIT } from "./fs.js";
// Security: Maximum size for SKILL.md files to prevent DoS attacks (10MB)
export const MAX_SKILL_FILE_SIZE = 10 * 1024 * 1024;

export const DEFAULT_SKILL_READ_LINE_LIMIT = 1000;

// Agent Skills specification constraints (https://agentskills.io/specification)
export const MAX_SKILL_NAME_LENGTH = 64;
export const MAX_SKILL_DESCRIPTION_LENGTH = 1024;
export const MAX_SKILL_COMPATIBILITY_LENGTH = 500;

/**
 * File extensions a skill module entrypoint may use.
 */
export const SKILL_MODULE_EXTENSIONS = [
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
  ".mts",
  ".cts",
  ".jsx",
  ".tsx",
];

/** `SKILL.md` frontmatter `metadata` key listing the skill's include names, space-separated. */
const INCLUDE_TOOLS_KEY = "include_tools";

/**
 * Metadata for a skill per Agent Skills specification.
 */
export interface SkillMetadata {
  /**
   * Skill identifier.
   *
   * Constraints per Agent Skills specification:
   *
   * - 1-64 characters
   * - Unicode lowercase alphanumeric and hyphens only (`a-z` and `-`).
   * - Must not start or end with `-`
   * - Must not contain consecutive `--`
   * - Must match the parent directory name containing the `SKILL.md` file
   */
  name: string;

  /**
   * What the skill does.
   *
   * Constraints per Agent Skills specification:
   *
   * - 1-1024 characters
   * - Should describe both what the skill does and when to use it
   * - Should include specific keywords that help agents identify relevant tasks
   */
  description: string;

  /** Path to the SKILL.md file in the backend */
  path: string;

  /** License name or reference to bundled license file. */
  license?: string | null;

  /**
   * Environment requirements.
   *
   * Constraints per Agent Skills specification:
   *
   * - 1-500 characters if provided
   * - Should only be included if there are specific compatibility requirements
   * - Can indicate intended product, required packages, etc.
   */
  compatibility?: string | null;

  /**
   * Arbitrary key-value mapping for additional metadata.
   *
   * Clients can use this to store additional properties not defined by the spec.
   *
   * It is recommended to keep key names unique to avoid conflicts.
   */
  metadata?: Record<string, string>;

  /**
   * Tool names the skill recommends using.
   *
   * Warning: this is experimental.
   *
   * Constraints per Agent Skills specification:
   *
   * - Space-delimited list of tool names
   */
  allowedTools?: string[];

  /**
   * Path to a JS/TS entrypoint file for a QuickJS REPL module, relative to the skill
   * directory.
   */
  module?: string;
}

/**
 * Return the skill tools that one `metadata.include_tools` name stands for.
 *
 * A resolver lets a skill list tools whose real names are only known at
 * runtime, such as generated MCP tool names, and lets one name stand for a
 * family of tools. It's called with the name and the agent's `runtime`, on
 * every model call while a read of a skill listing that name stays in context,
 * and again before one of its tools runs. It may return the tools or a
 * promise of them.
 *
 * - Return the same tools for the same name within a thread, or the prompt
 *   cache breaks: a change moves bytes at a position that has already been
 *   sent.
 * - Keep it cheap, or cache, since it runs on every model call.
 * - One resolver serves every thread, so scope any cache by what the tools
 *   depend on, usually something in `runtime.context`.
 * - Names are resolved concurrently, so cache the pending promise, not only
 *   its result.
 * - Exceptions propagate out of the model call or tool call. To degrade
 *   gracefully, catch inside the resolver and return `[]`.
 *
 * A name that exactly matches a tool already in the request is claimed by that
 * tool and never passed to the resolver.
 *
 * @example
 * ```typescript
 * // e.g. every tool on a Linear MCP connection, whatever their generated names
 * const resolveSkillTools: SkillToolResolver<{ workspaceId: string }> = async (
 *   name,
 *   runtime,
 * ) => (await toolsForWorkspace(runtime.context.workspaceId))[name] ?? [];
 *
 * createSkillsMiddleware({ backend, sources: ["/skills/"], tools: resolveSkillTools });
 * ```
 */
export type SkillToolResolver<TContext = unknown> = (
  name: string,
  runtime: Runtime<TContext>,
) => readonly ClientTool[] | Promise<readonly ClientTool[]>;

/**
 * Options for the skills middleware.
 *
 * @typeParam TContext - The agent's context type, as a `tools` resolver
 *   receives it on `runtime.context`.
 */
export interface SkillsMiddlewareOptions<TContext = unknown> {
  /**
   * Backend instance or factory function for file operations.
   * Use a factory for StateBackend since it requires runtime state.
   */
  backend:
    | AnyBackendProtocol
    | BackendFactory
    | ((config: { state: unknown; store?: BaseStore }) => StateBackend);

  /**
   * List of skill source paths to load.
   * Paths must use POSIX conventions (forward slashes).
   * Later sources override earlier ones for skills with the same name (last one wins).
   *
   * Two formats are accepted for each entry:
   *
   * - **Parent directory** (e.g. `"/skills/"`, `"/skills/user/"`): the directory
   *   is scanned and every subdirectory that contains a `SKILL.md` is loaded as
   *   a separate skill.
   *
   * - **Direct skill path** (e.g. `"/skills/my-skill/"`): the path points to a
   *   single skill directory whose `SKILL.md` lives at its root. Detected
   *   automatically when the directory listing contains a `SKILL.md` file.
   *
   * Both formats can be mixed in the same array:
   * ```typescript
   * sources: [
   *   "/skills/",                         // loads all skills in the directory
   *   "/skills/my-skill/",                // loads a single skill by path
   * ]
   * ```
   */
  sources: readonly string[];

  /**
   * Tools the model sees only after it reads a skill that lists them in its
   * `SKILL.md` frontmatter, as a space-separated `metadata.include_tools`.
   *
   * Pass an array of tools, or a {@link SkillToolResolver} that looks up the
   * tools one `include_tools` name stands for when a skill is read. Unlike
   * other middleware's tools, these are never registered with the agent: see
   * {@link createSkillsMiddleware} for how they are disclosed and gated.
   */
  tools?: readonly ClientTool[] | SkillToolResolver<TContext>;
}

/**
 * Zod schema for a single skill metadata entry.
 */
export const SkillMetadataEntrySchema = z.object({
  name: z.string(),
  description: z.string(),
  path: z.string(),
  license: z.string().nullable().optional(),
  compatibility: z.string().nullable().optional(),
  metadata: z.record(z.string(), z.string()).optional(),
  allowedTools: z.array(z.string()).optional(),
  module: z.string().optional(),
});

/**
 * Type for a single skill metadata entry.
 */
export type SkillMetadataEntry = z.infer<typeof SkillMetadataEntrySchema>;

/**
 * State value for a middleware's `skillsMetadata` field.
 *
 * A middleware can only read and write the fields declared on its own state
 * schema. A middleware that needs `skillsMetadata` — to inspect the skills
 * loaded for the thread, or to set the field to `null` and make the next model
 * call reload every source — declares it with this value.
 *
 * Treat the value as opaque: it is meant to be passed to `StateSchema`, and
 * its concrete type is an implementation detail that may change. To type an
 * individual entry, use {@link SkillMetadataEntry}.
 *
 * @example
 * ```typescript
 * import { createMiddleware } from "langchain";
 * import { StateSchema } from "@langchain/langgraph";
 * import { skillsMetadataValue } from "deepagents";
 *
 * const reloadEditedSkills = createMiddleware({
 *   name: "ReloadEditedSkills",
 *   stateSchema: new StateSchema({ skillsMetadata: skillsMetadataValue }),
 *   afterAgent: (state) =>
 *     agentEditedSkills(state) ? { skillsMetadata: null } : undefined,
 * });
 * ```
 */
export const skillsMetadataValue = z.array(SkillMetadataEntrySchema).nullish();

/**
 * State schema for skills middleware.
 */
const SkillsStateSchema = new StateSchema({
  skillsMetadata: skillsMetadataValue,
  files: filesValue,
  /**
   * The skill tools disclosed to the latest model call, each mapped to the
   * include name that produced it, for the tool-time gate. Written on every
   * model call.
   */
  _skillToolsDisclosed: z.record(z.string(), z.string()).optional(),
});

/**
 * Skills System Documentation prompt template.
 */
const SKILLS_SYSTEM_PROMPT = context`
  ## Skills System

  You have access to a skills library that provides specialized capabilities and domain knowledge.

  {skills_locations}

  **Available Skills:**

  {skills_list}

  **How to Use Skills (Progressive Disclosure):**

  Skills follow a **progressive disclosure** pattern - you know they exist (name + description above), but you only read the full instructions when needed:

  1. **Recognize when a skill applies**: Check if the user's task matches any skill's description
  2. **Read the skill's full instructions**: Use \`read_file\` on the path shown in the skill list above.
     Pass \`limit=${DEFAULT_SKILL_READ_LINE_LIMIT}\` since the default of ${DEFAULT_READ_LINE_LIMIT} lines is too small for most skill files.
  3. **Follow the skill's instructions**: SKILL.md contains step-by-step workflows, best practices, and examples
  4. **Access supporting files**: Skills may include scripts, configs, or reference docs - use absolute paths

  **When to Use Skills:**
  - When the user's request matches a skill's domain (e.g., "research X" → web-research skill)
  - When you need specialized knowledge or structured workflows
  - When a skill provides proven patterns for complex tasks
  **Skills are Self-Documenting:**
  - Each SKILL.md tells you exactly what the skill does and how to use it
  - The skill list above shows the full path for each skill's SKILL.md file

  **Executing Skill Scripts:**
  Skills may contain scripts or other executable files. Always use absolute paths from the skill list.

  **Example Workflow:**

  User: "Can you research the latest developments in quantum computing?"

  1. Check available skills above → See "web-research" skill with its full path
  2. Read the full skill file: \`read_file(file_path, limit=${DEFAULT_SKILL_READ_LINE_LIMIT})\`
  3. Follow the skill's research workflow (search → organize → synthesize)
  4. Use any helper scripts with absolute paths

  Remember: Skills are tools to make you more capable and consistent. When in doubt, check if a skill exists for the task!
`;

/**
 * Validate skill name per Agent Skills specification.
 *
 * Constraints per Agent Skills specification:
 *
 * - 1-64 characters
 * - Unicode lowercase alphanumeric and hyphens only (`a-z` and `-`).
 * - Must not start or end with `-`
 * - Must not contain consecutive `--`
 * - Must match the parent directory name containing the `SKILL.md` file
 *
 * Unicode lowercase alphanumeric means any lowercase or decimal digit, which
 * covers accented Latin characters (e.g., `'café'`, `'über-tool'`) and other
 * scripts.
 *
 * @param name - The skill name from YAML frontmatter
 * @param directoryName - The parent directory name
 * @returns `{ valid, error }` tuple. Error is empty string if valid.
 */
export function validateSkillName(
  name: string,
  directoryName: string,
): { valid: boolean; error: string } {
  if (!name) {
    return { valid: false, error: "name is required" };
  }
  if (name.length > MAX_SKILL_NAME_LENGTH) {
    return { valid: false, error: "name exceeds 64 characters" };
  }
  if (name.startsWith("-") || name.endsWith("-") || name.includes("--")) {
    return {
      valid: false,
      error: "name must be lowercase alphanumeric with single hyphens only",
    };
  }
  for (const c of name) {
    if (c === "-") continue;
    if (/\p{Ll}/u.test(c) || /\p{Nd}/u.test(c)) continue;
    return {
      valid: false,
      error: "name must be lowercase alphanumeric with single hyphens only",
    };
  }
  if (name !== directoryName) {
    return {
      valid: false,
      error: `name '${name}' must match directory name '${directoryName}'`,
    };
  }
  return { valid: true, error: "" };
}

/**
 * Validate and normalize the metadata field from YAML frontmatter.
 *
 * YAML parsing can return any type for the `metadata` key. This ensures the
 * value in {@link SkillMetadata} is always a `Record<string, string>` by
 * coercing via `String()` and rejecting non-object inputs. It also warns when
 * `include_tools` isn't a space-separated string of tool names.
 *
 * @param raw - Raw value from `frontmatterData.metadata`.
 * @param skillPath - Path to the `SKILL.md` file (for warning messages).
 * @returns A validated `Record<string, string>`.
 */
export function validateMetadata(
  raw: unknown,
  skillPath: string,
): Record<string, string> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    if (raw) {
      console.warn(
        `Ignoring non-object metadata in ${skillPath} (got ${typeof raw})`,
      );
    }
    return {};
  }
  const includeTools = (raw as Record<string, unknown>)[INCLUDE_TOOLS_KEY];
  // A YAML list would be coerced to `"a,b"`, whose names never match a tool.
  if (
    Array.isArray(includeTools) ||
    (typeof includeTools === "string" && includeTools.includes(","))
  ) {
    console.warn(
      `metadata.include_tools in ${skillPath} should be a space-separated string of tool names; got ${JSON.stringify(includeTools)}`,
    );
  }
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    result[String(k)] = String(v);
  }
  return result;
}

/**
 * Build a parenthetical annotation string from optional skill fields.
 *
 * Combines license and compatibility into a comma-separated string for
 * display in the system prompt skill listing.
 *
 * @param skill - Skill metadata to extract annotations from.
 * @returns Annotation string like `'License: MIT, Compatibility: Python 3.10+'`,
 *   or empty string if neither field is set.
 */
export function formatSkillAnnotations(skill: SkillMetadata): string {
  const parts: string[] = [];
  if (skill.license) {
    parts.push(`License: ${skill.license}`);
  }
  if (skill.compatibility) {
    parts.push(`Compatibility: ${skill.compatibility}`);
  }
  return parts.join(", ");
}

/**
 * Parse YAML frontmatter from `SKILL.md` content.
 *
 * Extracts metadata per Agent Skills specification from YAML frontmatter
 * delimited by `---` markers at the start of the content.
 *
 * @param content - Content of the `SKILL.md` file
 * @param skillPath - Path to the `SKILL.md` file (for error messages and metadata)
 * @param directoryName - Name of the parent directory containing the skill
 * @returns `SkillMetadata` if parsing succeeds, `null` if parsing fails or
 *   validation errors occur
 */
export function parseSkillMetadataFromContent(
  content: string,
  skillPath: string,
  directoryName: string,
): SkillMetadata | null {
  if (content.length > MAX_SKILL_FILE_SIZE) {
    console.warn(
      `Skipping ${skillPath}: content too large (${content.length} bytes)`,
    );
    return null;
  }

  // Match YAML frontmatter between --- delimiters
  const frontmatterPattern = /^---\s*\n([\s\S]*?)\n---\s*\n/;
  const match = content.match(frontmatterPattern);

  if (!match) {
    console.warn(`Skipping ${skillPath}: no valid YAML frontmatter found`);
    return null;
  }

  const frontmatterStr = match[1];

  // Parse YAML
  let frontmatterData: Record<string, unknown>;
  try {
    frontmatterData = yaml.parse(frontmatterStr);
  } catch (e) {
    console.warn(`Invalid YAML in ${skillPath}:`, e);
    return null;
  }

  if (!frontmatterData || typeof frontmatterData !== "object") {
    console.warn(`Skipping ${skillPath}: frontmatter is not a mapping`);
    return null;
  }

  // Validate required fields - coerce and strip whitespace
  const name = String(frontmatterData.name ?? "").trim();
  const description = String(frontmatterData.description ?? "").trim();

  if (!name || !description) {
    console.warn(
      `Skipping ${skillPath}: missing required 'name' or 'description'`,
    );
    return null;
  }

  // Validate name format per spec (warn but continue for backwards compatibility)
  const validation = validateSkillName(name, directoryName);
  if (!validation.valid) {
    console.warn(
      `Skill '${name}' in ${skillPath} does not follow Agent Skills specification: ${validation.error}. Consider renaming for spec compliance.`,
    );
  }

  // Validate description length per spec (max 1024 chars)
  let descriptionStr = description;
  if (descriptionStr.length > MAX_SKILL_DESCRIPTION_LENGTH) {
    console.warn(
      `Description exceeds ${MAX_SKILL_DESCRIPTION_LENGTH} characters in ${skillPath}, truncating`,
    );
    descriptionStr = descriptionStr.slice(0, MAX_SKILL_DESCRIPTION_LENGTH);
  }

  // Parse allowed-tools: support both YAML list and space-delimited string
  const rawTools = frontmatterData["allowed-tools"];
  let allowedTools: string[];
  if (rawTools) {
    if (Array.isArray(rawTools)) {
      allowedTools = rawTools.map((t) => String(t).trim()).filter(Boolean);
    } else {
      // Split on whitespace (handles multiple consecutive spaces)
      allowedTools = String(rawTools).split(/\s+/).filter(Boolean);
    }
  } else {
    allowedTools = [];
  }

  // Validate and truncate compatibility length
  let compatibilityStr =
    String(frontmatterData.compatibility ?? "").trim() || null;
  if (
    compatibilityStr &&
    compatibilityStr.length > MAX_SKILL_COMPATIBILITY_LENGTH
  ) {
    console.warn(
      `Compatibility exceeds ${MAX_SKILL_COMPATIBILITY_LENGTH} characters in ${skillPath}, truncating`,
    );
    compatibilityStr = compatibilityStr.slice(
      0,
      MAX_SKILL_COMPATIBILITY_LENGTH,
    );
  }

  return {
    name,
    description: descriptionStr,
    path: skillPath,
    metadata: validateMetadata(frontmatterData.metadata ?? {}, skillPath),
    license: String(frontmatterData.license ?? "").trim() || null,
    compatibility: compatibilityStr,
    allowedTools,
    module: validateModulePath(frontmatterData.module),
  };
}

/**
 * Read a single file from the backend, returning its content as a string or
 * null if the file does not exist or cannot be read.
 */
async function readFileFromBackend(
  backend: BackendProtocolV2,
  filePath: string,
): Promise<string | null> {
  if (backend.downloadFiles) {
    const results = await backend.downloadFiles([filePath]);
    if (results.length !== 1) {
      return null;
    }
    const response = results[0];
    if (response.error != null || response.content == null) {
      return null;
    }
    return new TextDecoder().decode(response.content);
  }
  const readResult = await backend.read(filePath);
  if (readResult.error) {
    return null;
  }
  if (typeof readResult.content !== "string") {
    return null;
  }
  return readResult.content;
}

/**
 * List all skills from a backend source.
 *
 * Supports two source formats:
 *
 * - **Parent directory** (e.g. `"/skills/"`): the directory is scanned for
 *   subdirectories, each of which must contain a `SKILL.md` file. This is the
 *   standard pattern for hosting a collection of skills in one place.
 *
 * - **Direct skill path** (e.g. `"/skills/my-skill/"`): the path points to a
 *   single skill directory that contains `SKILL.md` directly. Detected
 *   automatically when the directory listing includes a `SKILL.md` file entry.
 */
async function listSkillsFromBackend(
  backend: AnyBackendProtocol,
  sourcePath: string,
): Promise<SkillMetadata[]> {
  const adaptedBackend = adaptBackendProtocol(backend);
  const skills: SkillMetadata[] = [];

  // Detect path separator (Windows uses \, Unix uses /)
  const pathSep = sourcePath.includes("\\") ? "\\" : "/";

  // Normalize path to ensure it ends with the appropriate separator
  const normalizedPath =
    sourcePath.endsWith("/") || sourcePath.endsWith("\\")
      ? sourcePath
      : `${sourcePath}${pathSep}`;

  // List entries in the source directory (files and subdirectories) via ls
  let fileInfos: { path: string; is_dir?: boolean }[];
  try {
    const lsResult = await adaptedBackend.ls(normalizedPath);
    if (lsResult.error || !lsResult.files) {
      // Source path doesn't exist or can't be listed
      return [];
    }
    fileInfos = lsResult.files;
  } catch {
    // Source path doesn't exist or can't be listed
    return [];
  }

  // Convert FileInfo[] to entries format
  // Handle both forward slashes (Unix) and backslashes (Windows) in paths
  const entries = fileInfos.map((info) => ({
    name:
      info.path
        .replace(/[/\\]$/, "") // Remove trailing slash or backslash
        .split(/[/\\]/) // Split on either separator
        .pop() || "",
    type: (info.is_dir ? "directory" : "file") as "file" | "directory",
  }));

  // Direct skill path: SKILL.md lives immediately inside the source directory.
  // The source path itself is the skill — no subdirectory scan needed.
  if (entries.some((e) => e.type === "file" && e.name === "SKILL.md")) {
    const directoryName =
      normalizedPath
        .replace(/[/\\]$/, "")
        .split(/[/\\]/)
        .pop() || "";
    const skillMdPath = `${normalizedPath}SKILL.md`;
    const content = await readFileFromBackend(adaptedBackend, skillMdPath);
    if (content !== null) {
      const metadata = parseSkillMetadataFromContent(
        content,
        skillMdPath,
        directoryName,
      );
      if (metadata) {
        skills.push(metadata);
      }
    }
    return skills;
  }

  // Parent directory: scan subdirectories, each expected to contain SKILL.md.
  for (const entry of entries) {
    if (entry.type !== "directory") {
      continue;
    }

    const skillMdPath = `${normalizedPath}${entry.name}${pathSep}SKILL.md`;
    const content = await readFileFromBackend(adaptedBackend, skillMdPath);
    if (content === null) {
      continue;
    }

    const metadata = parseSkillMetadataFromContent(
      content,
      skillMdPath,
      entry.name,
    );

    if (metadata) {
      skills.push(metadata);
    }
  }

  return skills;
}

/**
 * Format skills locations for display in system prompt.
 * Shows priority indicator for the last source (highest priority).
 */
function formatSkillsLocations(sources: readonly string[]): string {
  if (sources.length === 0) {
    return "**Skills Sources:** None configured";
  }

  const lines: string[] = [];
  for (let i = 0; i < sources.length; i++) {
    const sourcePath = sources[i];
    // Extract a friendly name from the path (last non-empty component)
    // Handle both Unix (/) and Windows (\) path separators
    const name =
      sourcePath
        .replace(/[/\\]$/, "")
        .split(/[/\\]/)
        .filter(Boolean)
        .pop()
        ?.replace(/^./, (c) => c.toUpperCase()) || "Skills";
    const suffix = i === sources.length - 1 ? " (higher priority)" : "";
    lines.push(`**${name} Skills**: \`${sourcePath}\`${suffix}`);
  }
  return lines.join("\n");
}

/**
 * Format skills metadata for display in system prompt.
 * Shows allowed tools for each skill if specified.
 */
export function formatSkillsList(
  skills: SkillMetadata[],
  sources: readonly string[],
): string {
  if (skills.length === 0) {
    const paths = sources.map((s) => `\`${s}\``).join(" or ");
    return `(No skills available yet. You can create skills in ${paths})`;
  }

  const lines: string[] = [];
  for (const skill of skills) {
    const annotations = formatSkillAnnotations(skill);
    let descLine = `- **${skill.name}**: ${skill.description}`;
    if (annotations) {
      descLine += ` (${annotations})`;
    }
    lines.push(descLine);
    if (skill.allowedTools && skill.allowedTools.length > 0) {
      lines.push(`  → Allowed tools: ${skill.allowedTools.join(", ")}`);
    }
    lines.push(`  → Read \`${skill.path}\` for full instructions`);
    if (skill.module !== undefined) {
      lines.push(`  → Import: \`await import("@/skills/${skill.name}")\``);
    }
  }

  return lines.join("\n");
}

/**
 * Returns true when `value` ends with a recognized skill module extension.
 */
function endsWithModuleExtension(value: string): boolean {
  for (const ext of SKILL_MODULE_EXTENSIONS) {
    if (value.endsWith(ext)) {
      return true;
    }
  }
  return false;
}

/**
 * Validate and normalize the `module` frontmatter key from a `SKILL.md`.
 *
 * Returns the normalized path (e.g. `"index.ts"`, `"lib/entry.js"`) or
 * `undefined` when the key is absent, empty, non-string, absolute, contains
 * path traversal, or uses an unsupported extension. Invalid values silently
 * degrade the skill to prose-only.
 */
export function validateModulePath(raw: unknown): string | undefined {
  if (raw === null || raw === undefined) {
    return;
  }

  if (typeof raw !== "string") {
    return;
  }

  const stripped = raw.trim();
  if (stripped === "") {
    return;
  }

  // Normalize "./x" → "x" so the value lines up with the keys the loader
  // uses inside the installed module scope. Leaves "lib/util.js" untouched.
  const normalized = stripped.startsWith("./") ? stripped.slice(2) : stripped;

  if (normalized.startsWith("/")) {
    return;
  }

  if (
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.includes("/../") ||
    normalized.endsWith("/..")
  ) {
    return;
  }

  // Declaration files are type-only stubs with no runtime exports.
  if (
    normalized.endsWith(".d.ts") ||
    normalized.endsWith(".d.mts") ||
    normalized.endsWith(".d.cts")
  ) {
    return;
  }

  if (!endsWithModuleExtension(normalized)) {
    return;
  }

  return normalized;
}

// Skill tools: the tools a skill names in `metadata.include_tools`, disclosed
// once its `SKILL.md` has been read. The helpers below cover which reads of a
// `SKILL.md` count, how the include names a skill lists resolve to tools and
// which of those are disclosed, where the disclosure goes in the conversation,
// and the provider-native blocks that carry each tool's definition.
//
// An include name is one entry in a skill's `metadata.include_tools`: a tool's
// exact name, or a name a resolver maps to tools.

/** Tool `extras` key (and provider field) that withholds a tool's schema until searched for. */
const DEFER_LOADING = "defer_loading";

/**
 * Model ID prefixes that accept an inline `tool_definition` mid-conversation.
 *
 * `@langchain/anthropic` sends any mid-conversation system message in place,
 * without gating on the model, so this list is the only guard.
 */
const ANTHROPIC_INLINE_TOOL_MODELS = [
  "claude-opus-5",
  "claude-fable-5",
  "claude-mythos-5",
  "claude-opus-4-8",
];

/** Model ID prefixes whose Responses API accepts an `additional_tools` input item. */
const OPENAI_INLINE_TOOL_MODELS = ["gpt-6-", "gpt-5.6-"];

/** Root `input_schema` keys the Anthropic API rejects, failing the whole request. */
const ANTHROPIC_ROOT_COMBINATORS = ["oneOf", "anyOf", "allOf"] as const;

/** `extras` keys `ChatAnthropic` copies into a tool's definition, bar the ones a disclosure must never carry. */
const ANTHROPIC_DEFINITION_EXTRAS = [
  "input_examples",
  "allowed_callers",
  "strict",
] as const;

/** A resolver whose output {@link callSkillToolResolver} has yet to check. */
type UncheckedResolver = (name: string, runtime: Runtime<unknown>) => unknown;

/**
 * Return the resolver the skills middleware's `tools` option stands for.
 *
 * A list is validated, then resolved by exact name.
 *
 * @throws {ConfigurationError} If `tools` is neither a list nor a function,
 *   or a list entry isn't a client tool or repeats a name.
 */
function toSkillToolResolver(tools: unknown): UncheckedResolver {
  if (tools != null && !Array.isArray(tools)) {
    if (typeof tools !== "function") {
      throw new ConfigurationError(
        `tools must be an array of tools or a resolver function, got ${describeType(tools)}; wrap a single tool in an array`,
        "SKILL_TOOLS_UNSUPPORTED_TYPE",
      );
    }
    return tools as UncheckedResolver;
  }
  const entries: unknown[] = tools ?? [];
  if (!entries.every(isClientTool)) {
    throw new ConfigurationError(
      "tools entries must be client tools; provider-native tool objects are not supported",
      "SKILL_TOOLS_UNSUPPORTED_TYPE",
    );
  }
  const names = entries.map((t) => t.name);
  const duplicates = [
    ...new Set(names.filter((n, i) => names.indexOf(n) !== i)),
  ].sort();
  if (duplicates.length > 0) {
    throw new ConfigurationError(
      `tools contains duplicate tool name(s): ${duplicates.join(", ")}`,
      "SKILL_TOOLS_DUPLICATE_NAME",
    );
  }
  const byName = new Map(entries.map((t) => [t.name, t]));
  return (name) => (byName.has(name) ? [byName.get(name)] : []);
}

/** Whether `value` is a runnable client tool rather than a provider-native or plain object. */
function isClientTool(value: unknown): value is ClientTool {
  return Runnable.isRunnable(value) && typeof value.name === "string";
}

/**
 * Call `resolver` for one include name, keeping the first of each tool name.
 *
 * @throws {TypeError} If the resolver returns something other than an array
 *   of client tools.
 */
async function callSkillToolResolver(
  resolver: UncheckedResolver,
  includeName: string,
  runtime: Runtime<unknown>,
): Promise<ClientTool[]> {
  const result = await resolver(includeName, runtime);
  if (!Array.isArray(result)) {
    throw new TypeError(
      `skill tool resolver must return an array of tools for '${includeName}', got ${describeType(result)}`,
    );
  }
  const tools = new Map<string, ClientTool>();
  for (const item of result) {
    if (!isClientTool(item)) {
      throw new TypeError(
        `skill tool resolver returned a ${describeType(item)} for '${includeName}'; expected tool instances`,
      );
    }
    if (!tools.has(item.name)) tools.set(item.name, item);
  }
  return [...tools.values()];
}

/** Describe `value`'s type for an error message: its class name, or `typeof` for anything plainer. */
function describeType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value !== "object") return typeof value;
  const ctor = (value as { constructor?: { name?: unknown } }).constructor
    ?.name;
  return typeof ctor === "string" && ctor !== "" && ctor !== "Object"
    ? ctor
    : "plain object";
}

/** A successful `read_file` of a `SKILL.md` that lists tools. */
interface SkillRead {
  /** Index of the read's tool result in the request's messages. */
  index: number;
  /** The skill's name. */
  skillName: string;
  /** The entries of the skill's `metadata.include_tools`, in frontmatter order. */
  includeNames: string[];
}

/**
 * Return every successful `read_file` of a `SKILL.md` that lists tools, in
 * message order.
 *
 * Any `offset` or `limit` counts, and so does a result whose content was later
 * truncated or compacted, since only the call and the result's status are read.
 */
function findSkillReads(
  messages: readonly BaseMessage[],
  skills: readonly {
    name: string;
    path: string;
    metadata?: Record<string, string>;
  }[],
): SkillRead[] {
  const skillsByPath = new Map<string, Omit<SkillRead, "index">>();
  for (const skill of skills) {
    const value = skill.metadata?.[INCLUDE_TOOLS_KEY];
    const includeNames =
      typeof value === "string" ? value.split(/\s+/).filter(Boolean) : [];
    const path = normalizePath(skill.path);
    if (path !== undefined && includeNames.length > 0) {
      skillsByPath.set(path, { skillName: skill.name, includeNames });
    }
  }
  if (skillsByPath.size === 0) return [];
  const readPaths = new Map<string, unknown>();
  for (const message of messages) {
    if (!AIMessage.isInstance(message)) continue;
    for (const toolCall of message.tool_calls ?? []) {
      if (toolCall.name === "read_file" && toolCall.id) {
        readPaths.set(
          toolCall.id,
          toolCall.args?.file_path ?? toolCall.args?.path,
        );
      }
    }
  }
  const reads: SkillRead[] = [];
  messages.forEach((message, index) => {
    // A backend read error comes back as `Error: …` text, without an error status.
    if (
      !ToolMessage.isInstance(message) ||
      message.status === "error" ||
      message.text.startsWith("Error:")
    ) {
      return;
    }
    const path = normalizePath(readPaths.get(message.tool_call_id));
    const skill = path === undefined ? undefined : skillsByPath.get(path);
    if (skill !== undefined) reads.push({ index, ...skill });
  });
  return reads;
}

/**
 * Normalize `path`, or return `undefined` if it is invalid.
 *
 * Backslashes become slashes, empty and `.` segments are dropped, and a
 * relative path is made absolute. A `..` segment, a leading `~` or a Windows
 * drive makes the path invalid.
 */
function normalizePath(path: unknown): string | undefined {
  if (typeof path !== "string") return undefined;
  const segments = path.replaceAll("\\", "/").split("/");
  if (
    segments.includes("..") ||
    path.startsWith("~") ||
    /^[a-zA-Z]:/.test(path)
  ) {
    return undefined;
  }
  return `/${segments.filter((s) => s !== "" && s !== ".").join("/")}`;
}

/** A tool as it appears in `request.tools`: a tool instance, or a plain or provider-native object. */
type RequestTool = ClientTool | ServerTool;

/** A tool whose definition a disclosure can carry: a tool instance, or tool search's plain stand-in. */
type DisclosableTool = {
  name: string;
  description?: string;
  schema?: unknown;
  extras?: Record<string, unknown>;
};

/** A tool one model call discloses. */
interface DisclosedTool {
  /** The request's own entry for a deferred request tool, otherwise the skill tool. */
  tool: RequestTool;
  /** Index of the earliest skill read producing the tool; the disclosure is placed after it. */
  anchor: number;
  /**
   * The include name that produced a skill tool, for the tool-time lookup.
   * Absent for a deferred request tool, which is never gated.
   */
  includeName?: string;
}

/** Return a request tool's name, whether it is a tool instance or a provider object. */
function toolName(tool: RequestTool): string | undefined {
  const { name, function: fn } = tool as {
    name?: unknown;
    function?: { name?: unknown };
  };
  if (typeof name === "string") return name;
  return typeof fn?.name === "string" ? fn.name : undefined;
}

/**
 * Disclose the tools the read skills' include names produce to one model call.
 *
 * Returns the request to send, and the record of the skill tools it
 * discloses, for the tool-time gate.
 */
async function discloseSkillTools<TRequest extends ModelRequest<any, any>>(
  request: TRequest,
  reads: readonly SkillRead[],
  resolver: UncheckedResolver,
): Promise<{ request: TRequest; record: Record<string, string> }> {
  // The last of a repeated name wins.
  const requestTools = new Map<string, RequestTool>();
  for (const tool of request.tools) {
    const name = toolName(tool);
    if (name !== undefined) requestTools.set(name, tool);
  }
  // A name a request tool claims is never passed to the resolver.
  const names = [
    ...new Set(
      reads.flatMap((read) =>
        read.includeNames.filter((name) => !requestTools.has(name)),
      ),
    ),
  ];
  const tools = await Promise.all(
    names.map((name) => callSkillToolResolver(resolver, name, request.runtime)),
  );
  const resolved = new Map(names.map((name, i) => [name, tools[i]]));
  const disclosed = planDisclosure(reads, requestTools, resolved);
  if (disclosed.size === 0) return { request, record: {} };

  const chatModel = await resolveChatModel(request.model, request.runtime);
  if (llmType(chatModel) === "anthropic") {
    withholdRootCombinatorTools(disclosed);
  }
  const gatedNames = [...disclosed.keys()]
    .filter((name) => disclosed.get(name)!.includeName !== undefined)
    .sort();
  const record = Object.fromEntries(
    gatedNames.map((name) => [name, disclosed.get(name)!.includeName!]),
  );
  if (disclosed.size === 0) return { request, record };
  const build = inlineBlockBuilder(chatModel);
  if (build !== undefined) {
    return {
      request: {
        ...request,
        messages: discloseInMessages(request.messages, disclosed, build),
      },
      record,
    };
  }
  return {
    request: {
      ...request,
      tools: discloseInTools(request.tools, disclosed, gatedNames),
    },
    record,
  };
}

/**
 * Classify what each read skill's include names produce, anchoring each tool
 * at the earliest read producing it.
 *
 * An include name that matches a request tool's name produces that tool; any
 * other produces what the resolver returned for it. A produced tool whose name
 * a request tool has wins as that request tool, because it's the one that
 * runs: a deferred one is disclosed early, and a bound one adds nothing, since
 * the model already sees it. Tools are matched by name, never by identity,
 * because outer middleware such as tool search replaces the request's tools
 * with copies.
 */
function planDisclosure(
  reads: readonly SkillRead[],
  requestTools: ReadonlyMap<string, RequestTool>,
  resolved: ReadonlyMap<string, readonly ClientTool[]>,
): Map<string, DisclosedTool> {
  const disclosed = new Map<string, DisclosedTool>();
  const unresolved = new Set<string>();
  for (const { index, skillName, includeNames } of reads) {
    for (const includeName of includeNames) {
      const claimed = requestTools.get(includeName);
      const produced =
        claimed !== undefined ? [claimed] : (resolved.get(includeName) ?? []);
      if (produced.length === 0 && !unresolved.has(includeName)) {
        unresolved.add(includeName);
        // oxlint-disable-next-line no-console
        console.debug(
          `Skill '${skillName}' names tool '${includeName}', which is not available in this request`,
        );
      }
      for (const tool of produced) {
        const name = toolName(tool);
        if (name === undefined || disclosed.has(name)) continue;
        const entry = requestTools.get(name);
        if (entry === undefined) {
          disclosed.set(name, { tool, anchor: index, includeName });
        } else if (
          (entry as DisclosableTool).extras?.[DEFER_LOADING] === true
        ) {
          disclosed.set(name, { tool: entry, anchor: index });
        }
      }
    }
  }
  return disclosed;
}

/**
 * Withhold each disclosed tool whose root input schema uses `oneOf`, `anyOf`
 * or `allOf`, which the Anthropic API rejects, failing the whole request, in
 * `tools` and inline alike. Withholding it on every path keeps the record
 * equal to what the model was shown.
 */
function withholdRootCombinatorTools(
  disclosed: Map<string, DisclosedTool>,
): void {
  for (const [name, { tool }] of disclosed) {
    const schema = anthropicDefinition(tool as DisclosableTool).input_schema;
    const keys = ANTHROPIC_ROOT_COMBINATORS.filter(
      (key) =>
        typeof schema === "object" &&
        schema !== null &&
        Object.prototype.hasOwnProperty.call(schema, key),
    );
    if (keys.length > 0) {
      // oxlint-disable-next-line no-console
      console.warn(
        `Not disclosing tool '${name}': its input_schema has a top-level ${keys.join("/")}, which the Anthropic API does not support`,
      );
      disclosed.delete(name);
    }
  }
}

/**
 * Insert one `SystemMessage` per insertion point, carrying the tools anchored
 * there, for models that accept tool definitions mid-conversation.
 *
 * Each message lands at the same index with the same bytes on every call while
 * its anchor stays visible, so the provider's cached prefix survives.
 */
function discloseInMessages(
  messages: readonly BaseMessage[],
  disclosed: ReadonlyMap<string, DisclosedTool>,
  build: BlockBuilder,
): BaseMessage[] {
  const namesByIndex = new Map<number, string[]>();
  for (const [name, { anchor }] of disclosed) {
    // Insert after the anchor's tool-result batch and any user messages queued
    // behind it: Anthropic needs a system message after a user turn and before
    // an assistant turn, and OpenAI needs it to keep its position. An empty
    // reply is skipped too, because Anthropic drops it.
    let index = anchor + 1;
    while (index < messages.length) {
      const message = messages[index];
      const emptyReply =
        AIMessage.isInstance(message) &&
        message.content.length === 0 &&
        !message.tool_calls?.length;
      if (
        !ToolMessage.isInstance(message) &&
        !HumanMessage.isInstance(message) &&
        !emptyReply
      ) {
        break;
      }
      index += 1;
    }
    namesByIndex.set(index, [...(namesByIndex.get(index) ?? []), name]);
  }
  const result = [...messages];
  // Indexes were computed against the unmodified list, so insert back to front.
  for (const index of [...namesByIndex.keys()].sort((a, b) => b - a)) {
    const blocks = namesByIndex
      .get(index)!
      .sort()
      .map((name) => build(disclosed.get(name)!.tool as DisclosableTool));
    // Authored in `content`: the standard-content path drops provider-native blocks.
    result.splice(index, 0, new SystemMessage({ content: blocks as never }));
  }
  return result;
}

/**
 * Return `requestTools` with deferred disclosures undeferred and skill tools
 * appended, for models that can't take tool definitions mid-conversation.
 *
 * A deferred tool is replaced by a plain spec rather than a copy: `createAgent`
 * rejects a request that swaps a registered tool for another instance of the
 * same name, and doesn't validate plain objects.
 */
function discloseInTools(
  requestTools: readonly RequestTool[],
  disclosed: ReadonlyMap<string, DisclosedTool>,
  gatedNames: readonly string[],
): RequestTool[] {
  const tools = requestTools.map((tool): RequestTool => {
    const name = toolName(tool);
    const entry = name === undefined ? undefined : disclosed.get(name);
    if (entry?.tool !== tool || entry.includeName !== undefined) return tool;
    const { description, schema, extras = {} } = tool as DisclosableTool;
    const { [DEFER_LOADING]: _deferLoading, ...rest } = extras;
    return { name, description, schema, extras: rest };
  });
  return [...tools, ...gatedNames.map((name) => disclosed.get(name)!.tool)];
}

/** Return the model inside a `bind()` / `withConfig()` wrapper; chained calls merge into one. */
function unwrapBinding(model: unknown): unknown {
  return RunnableBinding.isRunnableBinding(model) ? model.bound : model;
}

/**
 * Return the concrete chat model a request will call.
 *
 * Resolves a `ConfigurableModel`, which a string `model` always becomes, to
 * the instance it will call with this run's `configurable`. Without
 * configurable overrides that's the instance cached at creation: the instance
 * cache is keyed on the whole config, so passing `configurable`
 * unconditionally would build one per thread.
 */
async function resolveChatModel(
  model: unknown,
  runtime: Runtime<unknown>,
): Promise<unknown> {
  const current = unwrapBinding(model) as {
    _queuedMethodOperations?: unknown;
    _getModelInstance?: (config?: object) => Promise<unknown>;
    _modelParams?: (config: object) => Record<string, unknown>;
  };
  // Duck-typed as langchain's own (unexported) `isConfigurableModel`.
  if (
    current?._queuedMethodOperations === undefined ||
    typeof current._getModelInstance !== "function"
  ) {
    return current;
  }
  const configurable = runtime.configurable ?? {};
  const overrides = current._modelParams?.({ configurable }) ?? {};
  const instance =
    Object.keys(overrides).length > 0
      ? await current._getModelInstance({ configurable })
      : await current._getModelInstance();
  return unwrapBinding(instance);
}

/** Return a chat model's `_llmType()`, which tells providers apart. */
function llmType(model: unknown): string | undefined {
  const fn = (model as { _llmType?: () => string } | null)?._llmType;
  return typeof fn === "function" ? fn.call(model) : undefined;
}

/** Builds the provider-native block that makes one tool callable from its position on. */
type BlockBuilder = (tool: DisclosableTool) => Record<string, unknown>;

/**
 * Return how `chatModel` is given a tool mid-conversation, or `undefined` if
 * it can't be.
 *
 * The one place that decides support, so a model-profile capability can
 * replace the allowlists later.
 */
function inlineBlockBuilder(chatModel: unknown): BlockBuilder | undefined {
  const { model: name, useResponsesApi } = chatModel as {
    model?: unknown;
    useResponsesApi?: unknown;
  };
  if (typeof name !== "string") return undefined;
  const type = llmType(chatModel);
  if (
    type === "anthropic" &&
    ANTHROPIC_INLINE_TOOL_MODELS.some((prefix) => name.startsWith(prefix))
  ) {
    return anthropicToolAddition;
  }
  // `_llmType()` tells `ChatOpenAI` apart from `AzureChatOpenAI`. Only an
  // explicit `useResponsesApi`: a `ChatOpenAI` that routes to the Responses
  // API on its own takes the fallback, which costs the cache but can't send
  // `additional_tools` on Chat Completions.
  if (
    type === "openai" &&
    useResponsesApi === true &&
    OPENAI_INLINE_TOOL_MODELS.some((prefix) => name.startsWith(prefix))
  ) {
    return openaiAdditionalTools;
  }
  return undefined;
}

/**
 * Return the definition `ChatAnthropic` sends in `tools` for `tool`, without
 * `defer_loading` (a deferred definition would stay withheld) or
 * `cache_control` (a stray marker uses up a breakpoint).
 */
function anthropicDefinition(tool: DisclosableTool): Record<string, unknown> {
  const definition: Record<string, unknown> = {
    name: tool.name,
    description: tool.description,
    input_schema: isInteropZodSchema(tool.schema)
      ? toJsonSchema(tool.schema)
      : tool.schema,
  };
  for (const key of ANTHROPIC_DEFINITION_EXTRAS) {
    if (tool.extras?.[key] !== undefined) definition[key] = tool.extras[key];
  }
  return definition;
}

/** Build the Anthropic `tool_addition` block carrying `tool`'s full definition. */
function anthropicToolAddition(tool: DisclosableTool): Record<string, unknown> {
  return {
    type: "tool_addition",
    tool: { type: "tool_definition", definition: anthropicDefinition(tool) },
  };
}

/** Build the OpenAI Responses `additional_tools` item carrying `tool`'s function schema. */
function openaiAdditionalTools(tool: DisclosableTool): Record<string, unknown> {
  const { function: fn } = convertToOpenAITool(tool as never);
  const { [DEFER_LOADING]: _deferLoading, ...definition } = {
    type: "function",
    ...fn,
  } as Record<string, unknown>;
  return { type: "additional_tools", role: "developer", tools: [definition] };
}

/**
 * Create backend-agnostic middleware for loading and exposing agent skills.
 *
 * This middleware loads skills from configurable backend sources and injects
 * skill metadata into the system prompt. It implements the progressive disclosure
 * pattern: skill names and descriptions are shown in the prompt, but the agent
 * reads full SKILL.md content only when needed.
 *
 * Skills are loaded once per thread and stored in state. To pick up skills
 * added, edited, or deleted since then, set `skillsMetadata` to `null`; the
 * next model call reloads every source:
 *
 * ```ts
 * await agent.updateState(config, { skillsMetadata: null });
 * // or as part of the next run's input
 * await agent.invoke({ messages, skillsMetadata: null }, config);
 * ```
 *
 * Loading happens in `beforeModel`, so the reload is served by the next model
 * call rather than the next run. A middleware of your own can therefore
 * invalidate from any hook — including mid-run, from `afterModel` — and see
 * the fresh list on the following call. See {@link skillsMetadataValue}.
 *
 * ## Skill tools
 *
 * A skill can list the tools its instructions use, separated by spaces, under
 * `metadata.include_tools` in its `SKILL.md` frontmatter:
 *
 * ```yaml
 * metadata:
 *   include_tools: create_customer_request list_customer_requests
 * ```
 *
 * Pass those tools as `tools`, either as an array or as a
 * {@link SkillToolResolver} that looks them up by name when a skill is read,
 * so one name can stand for a family of tools whose real names are only known
 * at runtime. The model sees a skill tool only after it reads, with
 * `read_file`, a skill that lists it, and only while that read stays in the
 * conversation it is sent; compaction that drops the read withdraws the tool.
 * Until then, calling the tool fails with the standard invalid-tool error and
 * the tool doesn't run. This controls what is in the model's context; it is
 * not a security boundary, since the model can read any `SKILL.md` at any
 * time.
 *
 * `include_tools` can also name a tool passed to the agent rather than to this
 * middleware. That tool wins over a skill tool of the same name. If it is
 * deferred
 * (`extras: { defer_loading: true }`), reading the skill discloses it early,
 * and it stays deferred and searchable; if it is bound, nothing changes.
 *
 * How a tool is disclosed depends on the model actually called:
 *
 * - **Models that accept tool definitions mid-conversation** — Anthropic
 *   inline tool definitions on the Claude API, and OpenAI `additional_tools`
 *   on the Responses API (`useResponsesApi: true`). The tool's definition is
 *   sent in a system message inserted right after the read's tool result, at
 *   the same position with the same bytes on every call, so the prompt cache
 *   survives.
 * - **Every other model** — the disclosed tools are appended to the request's
 *   `tools` instead. The gate is identical; only the cache cost differs.
 *
 * A tool whose root input schema uses `oneOf`, `anyOf` or `allOf` is never
 * disclosed to an Anthropic model, which would reject the whole request; a
 * warning names it.
 *
 * Inline disclosure needs `@langchain/anthropic` 1.5.12 or `@langchain/openai`
 * 1.6.2 or later. On an older Anthropic package every model call after a read
 * fails: with a 400 from the API, or, on packages older still, with "System
 * messages are only permitted as the first passed message". On an older
 * OpenAI package the tool never appears.
 *
 * Known gaps: only loads through `read_file` disclose tools; a resolver never
 * sees tools another middleware adds to the request; disclosed skill tools
 * can't be called from a code interpreter's REPL, and passing a skill tool to
 * a code interpreter's `ptc` allowlist bypasses the gate. On a model without
 * mid-conversation tool definitions, disclosing the only deferred tool leaves
 * `providerToolSearchMiddleware`'s search tool with nothing to search, which
 * OpenAI rejects. Skill tools aren't filtered by a harness profile's excluded
 * tools: a call to an excluded one is still rejected, but on a model that
 * accepts tool definitions mid-conversation its schema can be shown once its
 * skill is read.
 *
 * ## Placement
 *
 * `createDeepAgent` places this middleware for you. When composing
 * `createAgent` by hand, include `createFilesystemMiddleware`, whose
 * `read_file` the model uses to read skills. Put this middleware after
 * summarization and any model fallback or routing middleware, so it sees the
 * compacted conversation and the model actually called, and before prompt
 * caching. Never pass skill tools in `createAgent`'s `tools`, which would make
 * them callable without their skill:
 *
 * ```typescript
 * createAgent({
 *   model,
 *   tools: [...],
 *   middleware: [
 *     createFilesystemMiddleware({ backend }),
 *     // ...
 *     createSummarizationMiddleware({ backend }),
 *     modelFallbackMiddleware(fallbackModel),
 *     createSkillsMiddleware({ backend, sources: ["/skills/"], tools: [...] }),
 *     anthropicPromptCachingMiddleware(),
 *   ],
 * });
 * ```
 *
 * @param options - Configuration options
 * @returns AgentMiddleware for skills loading and injection
 * @throws {ConfigurationError} If `tools` is neither an array nor a
 *   function (`SKILL_TOOLS_UNSUPPORTED_TYPE`), an entry isn't a client tool
 *   (`SKILL_TOOLS_UNSUPPORTED_TYPE`), or two entries share a name
 *   (`SKILL_TOOLS_DUPLICATE_NAME`).
 *
 * @example
 * ```typescript
 * const middleware = createSkillsMiddleware({
 *   backend: new FilesystemBackend({ rootDir: "/" }),
 *   sources: ["/skills/user/", "/skills/project/"],
 * });
 * ```
 */
export function createSkillsMiddleware<TContext = unknown>(
  options: SkillsMiddlewareOptions<TContext>,
) {
  const { backend, sources } = options;
  const skillToolResolver = toSkillToolResolver(options.tools);

  return createMiddleware({
    name: "SkillsMiddleware",
    stateSchema: SkillsStateSchema,

    async beforeModel(state) {
      // What state holds for this thread:
      // - missing, `undefined` or `null`: not loaded, or the caller reset it.
      //   Load every source.
      // - `[]`: loaded, and the sources contain no skills. Keep it.
      // - a non-empty list: loaded. Keep it.
      if (state.skillsMetadata !== null && state.skillsMetadata !== undefined) {
        return undefined;
      }

      const resolvedBackend = await resolveBackend(backend, {
        state,
      });
      const allSkills: Map<string, SkillMetadata> = new Map();

      // Load skills from each source in order (later sources override earlier)
      for (const sourcePath of sources) {
        try {
          const skills = await listSkillsFromBackend(
            resolvedBackend,
            sourcePath,
          );
          for (const skill of skills) {
            allSkills.set(skill.name, skill);
          }
        } catch (error) {
          // Log but continue - individual source failures shouldn't break everything
          console.debug(
            `[BackendSkillsMiddleware] Failed to load skills from ${sourcePath}:`,
            error,
          );
        }
      }

      return { skillsMetadata: Array.from(allSkills.values()) };
    },

    async wrapModelCall(request, handler) {
      // Populated by beforeModel, which runs as its own graph node - its
      // state update is committed before the model node reads it.
      const skillsMetadata: SkillMetadata[] =
        (request.state?.skillsMetadata as SkillMetadata[]) || [];

      // Format skills section
      const skillsLocations = formatSkillsLocations(sources);
      const skillsList = formatSkillsList(skillsMetadata, sources);

      const skillsSection = SKILLS_SYSTEM_PROMPT.replace(
        "{skills_locations}",
        skillsLocations,
      ).replace("{skills_list}", skillsList);

      // Combine with existing system message
      const newSystemMessage = request.systemMessage.concat(skillsSection);

      const prompted = { ...request, systemMessage: newSystemMessage };
      const reads = findSkillReads(request.messages, skillsMetadata);
      // No read of a skill naming tools: nothing to resolve or disclose.
      const { request: disclosed, record } =
        reads.length === 0
          ? { request: prompted, record: {} }
          : await discloseSkillTools(prompted, reads, skillToolResolver);
      const response: unknown = await handler(disclosed);
      // A native structured-output response comes back as a state update
      // rather than an AIMessage; carry it, or returning a Command drops it.
      const structured =
        typeof response === "object" &&
        response !== null &&
        "structuredResponse" in response &&
        "messages" in response;
      // Written on every call, `{}` included, so the tool-time gate admits
      // exactly the skill tools this call was shown, and a record left by an
      // earlier build never outlives the next model call.
      return new Command({
        update: {
          _skillToolsDisclosed: record,
          ...(structured && {
            structuredResponse: response.structuredResponse,
          }),
        },
      });
    },

    async wrapToolCall(request, handler) {
      // A registered tool, or one an outer middleware supplied: not ours.
      if (request.tool !== undefined) return handler(request);
      const name = request.toolCall.name;
      const record = request.state._skillToolsDisclosed ?? {};
      const includeName = Object.hasOwn(record, name)
        ? record[name]
        : undefined;
      // Not shown to the latest model call: the tool node answers with its
      // standard invalid-tool error, which lists only registered tools.
      if (includeName === undefined) return handler(request);
      const tools = await callSkillToolResolver(
        skillToolResolver,
        includeName,
        request.runtime,
      );
      const tool = tools.find((candidate) => candidate.name === name);
      if (tool === undefined) {
        console.warn(
          `Skill tool '${name}' was disclosed via '${includeName}', but the resolver no longer returns it`,
        );
        return handler(request);
      }
      return handler({ ...request, tool });
    },
  });
}

/**
 * The middleware value returned by {@link createSkillsMiddleware}.
 *
 * Exported so `createDeepAgent` can splice the skills state (`skillsMetadata`)
 * into an agent's inferred state when the `skills` option is present, without
 * the caller having to mount the middleware by hand.
 */
export type SkillsMiddleware = ReturnType<typeof createSkillsMiddleware>;
