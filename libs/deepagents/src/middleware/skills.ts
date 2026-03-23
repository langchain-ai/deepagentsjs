/* eslint-disable no-console */
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
 *     "/skills/user/",
 *     "/skills/project/",
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
 *   skills: ["/skills/user/", "/skills/project/"],
 * });
 * ```
 */

import { z } from "zod";
import yaml from "yaml";
import {
  createMiddleware,
  /**
   * required for type inference
   */
  type AgentMiddleware as _AgentMiddleware,
} from "langchain";
import { StateSchema, ReducedValue } from "@langchain/langgraph";

import type { BackendProtocol, BackendFactory } from "../backends/protocol.js";
import type { StateBackend } from "../backends/state.js";
import type { BaseStore } from "@langchain/langgraph-checkpoint";
import { filesValue } from "../values.js";

// Security: Maximum size for SKILL.md files to prevent DoS attacks (10MB)
export const MAX_SKILL_FILE_SIZE = 10 * 1024 * 1024;

// Agent Skills specification constraints (https://agentskills.io/specification)
export const MAX_SKILL_NAME_LENGTH = 64;
export const MAX_SKILL_DESCRIPTION_LENGTH = 1024;
export const MAX_SKILL_COMPATIBILITY_LENGTH = 500;

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
}

/**
 * Options for the skills middleware.
 */
export interface SkillsMiddlewareOptions {
  /**
   * Backend instance or factory function for file operations.
   * Use a factory for StateBackend since it requires runtime state.
   */
  backend:
    | BackendProtocol
    | BackendFactory
    | ((config: { state: unknown; store?: BaseStore }) => StateBackend);

  /**
   * List of skill source paths to load (e.g., ["/skills/user/", "/skills/project/"]).
   * Paths must use POSIX conventions (forward slashes).
   * Later sources override earlier ones for skills with the same name (last one wins).
   */
  sources: string[];
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
});

/**
 * Type for a single skill metadata entry.
 */
export type SkillMetadataEntry = z.infer<typeof SkillMetadataEntrySchema>;

/**
 * Reducer for skillsMetadata that merges arrays from parallel subagents.
 * Skills are deduplicated by name, with later values overriding earlier ones.
 *
 * @param current - The current skillsMetadata array (from state)
 * @param update - The new skillsMetadata array (from a subagent update)
 * @returns Merged array with duplicates resolved by name (later values win)
 */
export function skillsMetadataReducer(
  current: SkillMetadataEntry[] | undefined,
  update: SkillMetadataEntry[] | undefined,
): SkillMetadataEntry[] {
  // If no update, return current (or empty array)
  if (!update || update.length === 0) {
    return current || [];
  }
  // If no current, return update
  if (!current || current.length === 0) {
    return update;
  }
  // Merge by skill name (later values override earlier ones)
  const merged = new Map<string, SkillMetadataEntry>();
  for (const skill of current) {
    merged.set(skill.name, skill);
  }
  for (const skill of update) {
    merged.set(skill.name, skill);
  }
  return Array.from(merged.values());
}

/**
 * State schema for skills middleware.
 * Uses ReducedValue for skillsMetadata to allow concurrent updates from parallel subagents.
 */
const SkillsStateSchema = new StateSchema({
  skillsMetadata: new ReducedValue(
    z.array(SkillMetadataEntrySchema).default(() => []),
    {
      inputSchema: z.array(SkillMetadataEntrySchema).optional(),
      reducer: skillsMetadataReducer,
    },
  ),
  files: filesValue,
});

/**
 * Skills System Documentation prompt template.
 */
const SKILLS_SYSTEM_PROMPT = `
## Skills System

You have access to a skills library that provides specialized capabilities and domain knowledge.

{skills_locations}

**Available Skills:**

{skills_list}

**How to Use Skills (Progressive Disclosure):**

Skills follow a **progressive disclosure** pattern - you know they exist (name + description above), but you only read the full instructions when needed:

1. **Recognize when a skill applies**: Check if the user's task matches any skill's description
2. **Read the skill's full instructions**: The skill list above shows the exact path to use with read_file
3. **Follow the skill's instructions**: SKILL.md contains step-by-step workflows, best practices, and examples
4. **Access supporting files**: Skills may include Python scripts, configs, or reference docs - use absolute paths

**When to Use Skills:**
- When the user's request matches a skill's domain (e.g., "research X" → web-research skill)
- When you need specialized knowledge or structured workflows
- When a skill provides proven patterns for complex tasks

**Skills are Self-Documenting:**
- Each SKILL.md tells you exactly what the skill does and how to use it
- The skill list above shows the full path for each skill's SKILL.md file

**Executing Skill Scripts:**
Skills may contain Python scripts or other executable files. Always use absolute paths from the skill list.

**Example Workflow:**

User: "Can you research the latest developments in quantum computing?"

1. Check available skills above → See "web-research" skill with its full path
2. Read the skill using the path shown in the list
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
 * coercing via `String()` and rejecting non-object inputs.
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
  };
}

/**
 * List all skills from a backend source.
 */
async function listSkillsFromBackend(
  backend: BackendProtocol,
  sourcePath: string,
): Promise<SkillMetadata[]> {
  const skills: SkillMetadata[] = [];

  // Detect path separator (Windows uses \, Unix uses /)
  const pathSep = sourcePath.includes("\\") ? "\\" : "/";

  // Normalize path to ensure it ends with the appropriate separator
  const normalizedPath =
    sourcePath.endsWith("/") || sourcePath.endsWith("\\")
      ? sourcePath
      : `${sourcePath}${pathSep}`;

  // List directories in the source path using lsInfo
  let fileInfos: { path: string; is_dir?: boolean }[];
  try {
    fileInfos = await backend.lsInfo(normalizedPath);
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

  // Look for subdirectories containing SKILL.md
  for (const entry of entries) {
    if (entry.type !== "directory") {
      continue;
    }

    const skillMdPath = `${normalizedPath}${entry.name}${pathSep}SKILL.md`;

    // Try to download the SKILL.md file
    let content: string;
    if (backend.downloadFiles) {
      const results = await backend.downloadFiles([skillMdPath]);
      if (results.length !== 1) {
        continue;
      }

      const response = results[0];
      if (response.error != null || response.content == null) {
        continue;
      }

      // Decode content
      content = new TextDecoder().decode(response.content);
    } else {
      // Fall back to read if downloadFiles is not available
      const readResult = await backend.read(skillMdPath);
      if (readResult.startsWith("Error:")) {
        continue;
      }
      content = readResult;
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
function formatSkillsLocations(sources: string[]): string {
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
  sources: string[],
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
  }

  return lines.join("\n");
}

/**
 * Create backend-agnostic middleware for loading and exposing agent skills.
 *
 * This middleware loads skills from configurable backend sources and injects
 * skill metadata into the system prompt. It implements the progressive disclosure
 * pattern: skill names and descriptions are shown in the prompt, but the agent
 * reads full SKILL.md content only when needed.
 *
 * @param options - Configuration options
 * @returns AgentMiddleware for skills loading and injection
 *
 * @example
 * ```typescript
 * const middleware = createSkillsMiddleware({
 *   backend: new FilesystemBackend({ rootDir: "/" }),
 *   sources: ["/skills/user/", "/skills/project/"],
 * });
 * ```
 */
export function createSkillsMiddleware(options: SkillsMiddlewareOptions) {
  const { backend, sources } = options;

  // Closure variable to store loaded skills - wrapModelCall can access this
  // directly since beforeAgent state updates aren't immediately available
  let loadedSkills: SkillMetadata[] = [];

  /**
   * Resolve backend from instance or factory.
   */
  function getBackend(state: unknown): BackendProtocol {
    if (typeof backend === "function") {
      return backend({ state }) as BackendProtocol;
    }
    return backend;
  }

  return createMiddleware({
    name: "SkillsMiddleware",
    stateSchema: SkillsStateSchema,

    async beforeAgent(state) {
      // Skip if already loaded (check both closure and state)
      if (loadedSkills.length > 0) {
        return undefined;
      }
      // Check if skills were restored from checkpoint (non-empty array in state)
      if (
        "skillsMetadata" in state &&
        Array.isArray(state.skillsMetadata) &&
        state.skillsMetadata.length > 0
      ) {
        // Restore from state (e.g., after checkpoint restore)
        loadedSkills = state.skillsMetadata as SkillMetadata[];
        return undefined;
      }

      const resolvedBackend = getBackend(state);
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

      // Store in closure for immediate access by wrapModelCall
      loadedSkills = Array.from(allSkills.values());

      return { skillsMetadata: loadedSkills };
    },

    wrapModelCall(request, handler) {
      // Use closure variable which is populated by beforeAgent
      // Fall back to state for checkpoint restore scenarios
      const skillsMetadata: SkillMetadata[] =
        loadedSkills.length > 0
          ? loadedSkills
          : (request.state?.skillsMetadata as SkillMetadata[]) || [];

      // Format skills section
      const skillsLocations = formatSkillsLocations(sources);
      const skillsList = formatSkillsList(skillsMetadata, sources);

      const skillsSection = SKILLS_SYSTEM_PROMPT.replace(
        "{skills_locations}",
        skillsLocations,
      ).replace("{skills_list}", skillsList);

      // Combine with existing system message
      const newSystemMessage = request.systemMessage.concat(skillsSection);

      return handler({ ...request, systemMessage: newSystemMessage });
    },
  });
}
