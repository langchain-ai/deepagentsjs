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

import type { BackendProtocol, BackendFactory } from "../backends/protocol.js";
import type { StateBackend } from "../backends/state.js";
import type { BaseStore } from "@langchain/langgraph-checkpoint";

// Security: Maximum size for SKILL.md files to prevent DoS attacks (10MB)
export const MAX_SKILL_FILE_SIZE = 10 * 1024 * 1024;

// Agent Skills specification constraints (https://agentskills.io/specification)
export const MAX_SKILL_NAME_LENGTH = 64;
export const MAX_SKILL_DESCRIPTION_LENGTH = 1024;

/**
 * Metadata for a skill per Agent Skills specification.
 */
export interface SkillMetadata {
  /** Skill identifier (max 64 chars, lowercase alphanumeric and hyphens) */
  name: string;

  /** What the skill does (max 1024 chars) */
  description: string;

  /** Path to the SKILL.md file in the backend */
  path: string;

  /** License name or reference to bundled license file */
  license?: string | null;

  /** Environment requirements (max 500 chars) */
  compatibility?: string | null;

  /** Arbitrary key-value mapping for additional metadata */
  metadata?: Record<string, string>;

  /** List of pre-approved tools (experimental) */
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
 * State schema for skills middleware.
 */
const SkillsStateSchema = z.object({
  skillsMetadata: z
    .array(
      z.object({
        name: z.string(),
        description: z.string(),
        path: z.string(),
        license: z.string().nullable().optional(),
        compatibility: z.string().nullable().optional(),
        metadata: z.record(z.string(), z.string()).optional(),
        allowedTools: z.array(z.string()).optional(),
      }),
    )
    .optional(),
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
 */
function validateSkillName(
  name: string,
  directoryName: string,
): { valid: boolean; error: string } {
  if (!name) {
    return { valid: false, error: "name is required" };
  }
  if (name.length > MAX_SKILL_NAME_LENGTH) {
    return { valid: false, error: "name exceeds 64 characters" };
  }
  // Pattern: lowercase alphanumeric, single hyphens between segments, no start/end hyphen
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) {
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
 * Parse YAML frontmatter from SKILL.md content.
 */
function parseSkillMetadataFromContent(
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

  // Validate required fields
  const name = frontmatterData.name as string | undefined;
  const description = frontmatterData.description as string | undefined;

  if (!name || !description) {
    console.warn(
      `Skipping ${skillPath}: missing required 'name' or 'description'`,
    );
    return null;
  }

  // Validate name format per spec (warn but continue for backwards compatibility)
  const validation = validateSkillName(String(name), directoryName);
  if (!validation.valid) {
    console.warn(
      `Skill '${name}' in ${skillPath} does not follow Agent Skills specification: ${validation.error}. Consider renaming for spec compliance.`,
    );
  }

  // Validate description length per spec (max 1024 chars)
  let descriptionStr = String(description).trim();
  if (descriptionStr.length > MAX_SKILL_DESCRIPTION_LENGTH) {
    console.warn(
      `Description exceeds ${MAX_SKILL_DESCRIPTION_LENGTH} characters in ${skillPath}, truncating`,
    );
    descriptionStr = descriptionStr.slice(0, MAX_SKILL_DESCRIPTION_LENGTH);
  }

  // Parse allowed-tools
  const allowedToolsStr = frontmatterData["allowed-tools"] as
    | string
    | undefined;
  const allowedTools = allowedToolsStr ? allowedToolsStr.split(" ") : [];

  return {
    name: String(name),
    description: descriptionStr,
    path: skillPath,
    metadata: (frontmatterData.metadata as Record<string, string>) || {},
    license:
      typeof frontmatterData.license === "string"
        ? frontmatterData.license.trim() || null
        : null,
    compatibility:
      typeof frontmatterData.compatibility === "string"
        ? frontmatterData.compatibility.trim() || null
        : null,
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

  // Normalize path to ensure it ends with /
  const normalizedPath = sourcePath.endsWith("/")
    ? sourcePath
    : `${sourcePath}/`;

  // List directories in the source path using lsInfo
  let fileInfos: { path: string; is_dir?: boolean }[];
  try {
    fileInfos = await backend.lsInfo(normalizedPath);
  } catch {
    // Source path doesn't exist or can't be listed
    return [];
  }

  // Convert FileInfo[] to entries format
  const entries = fileInfos.map((info) => ({
    name: info.path.replace(/\/$/, "").split("/").pop() || "",
    type: (info.is_dir ? "directory" : "file") as "file" | "directory",
  }));

  // Look for subdirectories containing SKILL.md
  for (const entry of entries) {
    if (entry.type !== "directory") {
      continue;
    }

    const skillMdPath = `${normalizedPath}${entry.name}/SKILL.md`;

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
 */
function formatSkillsLocations(sources: string[]): string {
  if (sources.length === 0) {
    return "**Skills Sources:** None configured";
  }

  const lines = ["**Skills Sources:**"];
  for (const source of sources) {
    lines.push(`- \`${source}\``);
  }
  return lines.join("\n");
}

/**
 * Format skills metadata for display in system prompt.
 */
function formatSkillsList(skills: SkillMetadata[], sources: string[]): string {
  if (skills.length === 0) {
    return `(No skills available yet. Skills can be created in ${sources.join(" or ")})`;
  }

  const lines: string[] = [];
  for (const skill of skills) {
    lines.push(`- **${skill.name}**: ${skill.description}`);
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
      if ("skillsMetadata" in state && state.skillsMetadata != null) {
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

      // Append to existing system prompt
      const currentSystemPrompt = request.systemPrompt || "";
      const newSystemPrompt = currentSystemPrompt
        ? `${currentSystemPrompt}\n\n${skillsSection}`
        : skillsSection;

      return handler({ ...request, systemPrompt: newSystemPrompt });
    },
  });
}
