/**
 * Backend-agnostic skills middleware for loading agent skills from any
 * backend.
 *
 * The middleware loads skills from one or more configured **sources** —
 * paths in a backend where skills are organized. Sources are loaded in
 * order, with later sources overriding earlier ones when skills have the
 * same name (last one wins). This enables layering: base → user →
 * project → team skills.
 *
 * The middleware uses backend APIs exclusively (no direct filesystem
 * access), making it portable across different storage backends
 * (filesystem, state, remote storage, etc.).
 *
 * Discovery primitives live in `../skills/discovery.ts`. This file is
 * focused on the middleware wiring: state schema, system-prompt
 * rendering, and the agent-facing factory.
 */

import { z } from "zod";
import {
  context,
  createMiddleware,
  tool,
  /**
   * required for type inference
   */
  type AgentMiddleware as _AgentMiddleware,
} from "langchain";
import { StateSchema, ReducedValue } from "@langchain/langgraph";

import type {
  AnyBackendProtocol,
  BackendFactory,
} from "../backends/protocol.js";
import type { StateBackend } from "../backends/state.js";
import type { BaseStore } from "@langchain/langgraph-checkpoint";
import { filesValue } from "../values.js";

import type { SkillMetadata, SkillMetadataEntry } from "../skills/discovery.js";
import { SkillMetadataEntrySchema } from "../skills/discovery.js";
import { SkillProvider } from "../skills/provider.js";
import { SkillRegistry } from "../skills/registry.js";

// Re-export discovery primitives from this module so existing callers
// that import from `./middleware/skills.js` keep working without source
// edits.
export {
  parseSkillMetadataFromContent,
  validateSkillName,
  validateModulePath,
  validateMetadata,
  listSkillsFromBackend,
  SKILL_MODULE_EXTENSIONS,
  MAX_SKILL_FILE_SIZE,
  MAX_SKILL_NAME_LENGTH,
  MAX_SKILL_DESCRIPTION_LENGTH,
  MAX_SKILL_COMPATIBILITY_LENGTH,
  SkillMetadataEntrySchema,
  type SkillMetadata,
  type SkillMetadataEntry,
} from "../skills/discovery.js";

/**
 * Options for the skills middleware.
 */
export interface SkillsMiddlewareOptions {
  /**
   * Backend instance or factory function for file operations. Use a
   * factory for `StateBackend` since it requires runtime state.
   */
  backend:
    | AnyBackendProtocol
    | BackendFactory
    | ((config: { state: unknown; store?: BaseStore }) => StateBackend);

  /**
   * List of skill source paths to load
   * (e.g. `["/skills/user/", "/skills/project/"]`). Paths use POSIX
   * conventions. Later sources override earlier ones for skills with the
   * same name (last one wins).
   */
  sources: (string | SkillProvider)[];
}

/**
 * Extract a human-readable message from a value caught in a `catch`
 * clause. Performs a shape check rather than `instanceof Error` since the
 * codebase prohibits `instanceof` (cross-realm errors fail it silently).
 */
function errorMessage(err: unknown): string {
  if (
    err !== null &&
    typeof err === "object" &&
    "message" in err &&
    typeof (err as { message: unknown }).message === "string"
  ) {
    return (err as { message: string }).message;
  }
  return String(err);
}

/**
 * Reducer for `skillsMetadata` that merges arrays from parallel
 * subagents. Skills are deduplicated by name, with later values
 * overriding earlier ones.
 */
export function skillsMetadataReducer(
  current: SkillMetadataEntry[] | undefined,
  update: SkillMetadataEntry[] | undefined,
): SkillMetadataEntry[] {
  if (!update || update.length === 0) {
    return current ?? [];
  }
  if (!current || current.length === 0) {
    return update;
  }

  const merged = new Map<string, SkillMetadataEntry>();
  for (const skill of current) {
    merged.set(skill.name, skill);
  }
  for (const skill of update) {
    merged.set(skill.name, skill);
  }
  return [...merged.values()];
}

/**
 * State schema for the skills middleware. `skillsMetadata` uses
 * `ReducedValue` so parallel subagents can merge updates without
 * clobbering each other.
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
 * System-prompt template documenting the skills system to the agent.
 * Phase 4 replaces the read_file activation guidance with the
 * `skill(name)` tool.
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
  2. **Load the skill's full instructions**: Call \`skill({ name: "<skill-name>" })\` to load the full SKILL.md.
  3. **Follow the skill's instructions**: SKILL.md contains step-by-step workflows, best practices, and examples
  4. **Access supporting files**: Skills may include scripts, configs, or reference docs - use absolute paths

  **When to Use Skills:**
  - When the user's request matches a skill's domain (e.g., "research X" → web-research skill)
  - When you need specialized knowledge or structured workflows
  - When a skill provides proven patterns for complex tasks

  Remember: Skills are tools to make you more capable and consistent. When in doubt, check if a skill exists for the task!
`;

/**
 * Build a parenthetical annotation string from optional skill fields.
 * Combines license and compatibility into a comma-separated string for
 * display in the system-prompt skill listing.
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
 * Format skills locations for display in the system prompt. Shows a
 * priority indicator next to the last source.
 */
function formatSkillsLocations(sources: string[]): string {
  if (sources.length === 0) {
    return "**Skills Sources:** None configured";
  }

  const lines: string[] = [];
  for (let i = 0; i < sources.length; i++) {
    const sourcePath = sources[i];
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
 * Format skills metadata for display in the system prompt. Includes the
 * allowed-tools annotation for each skill if specified, and an `Import`
 * hint for skills that expose an importable entrypoint.
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
    const head = annotations
      ? `- **${skill.name}**: ${skill.description} (${annotations})`
      : `- **${skill.name}**: ${skill.description}`;
    lines.push(head);

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
 * Build the skills middleware.
 *
 * Loads skills from configurable backend sources and injects skill
 * metadata into the system prompt. Implements the progressive disclosure
 * pattern: skill names and descriptions appear in the prompt; the agent
 * reads full SKILL.md content only when needed (Phase 4 replaces this
 * with a dedicated `skill(name)` tool).
 *
 * @example
 * ```ts
 * const middleware = createSkillsMiddleware({
 *   backend: new FilesystemBackend({ rootDir: "/" }),
 *   sources: ["/skills/user/", "/skills/project/"],
 * });
 * ```
 */
export function createSkillsMiddleware(options: SkillsMiddlewareOptions) {
  const registry = new SkillRegistry({
    skills: options.sources,
    backend: options.backend,
  });

  const promptSources = options.sources.filter(
    (entry): entry is string => typeof entry === "string",
  );

  return createSkillsMiddlewareFromRegistry(registry, promptSources);
}

/**
 * Build the skills middleware from a pre-constructed `SkillRegistry`.
 * Used by `createDeepAgent` so a single registry instance can feed both
 * this middleware and any opt-in user middleware.
 *
 * @internal
 */
export function createSkillsMiddlewareFromRegistry(
  registry: SkillRegistry,
  promptSources: string[] = [],
) {
  let loadedSkills: SkillMetadata[] = [];

  const skillTool = tool(
    async ({ name }: { name: string }) => {
      const metadata = loadedSkills.find((s) => s.name === name);
      if (metadata === undefined) {
        const available =
          loadedSkills.map((s) => s.name).join(", ") || "(none)";
        return `Skill '${name}' is not available. Available skills: ${available}`;
      }
      try {
        const result = await registry.load(name);
        return result.body;
      } catch (err) {
        return `Failed to load skill '${name}': ${errorMessage(err)}`;
      }
    },
    {
      name: "skill",
      description:
        "Activate a skill by name. Returns the full SKILL.md instructions for the named skill. Call this when the user's task matches one of the skills listed in the system prompt.",
      schema: z.object({
        name: z
          .string()
          .describe("Name of the skill to activate (kebab-case identifier)."),
      }),
    },
  );

  return createMiddleware({
    name: "SkillsMiddleware",
    stateSchema: SkillsStateSchema,
    tools: [skillTool],

    async beforeAgent(state) {
      if (loadedSkills.length > 0) {
        return undefined;
      }
      if (
        "skillsMetadata" in state &&
        Array.isArray(state.skillsMetadata) &&
        state.skillsMetadata.length > 0
      ) {
        loadedSkills = state.skillsMetadata as SkillMetadata[];
        return undefined;
      }

      try {
        loadedSkills = await registry.list(state);
      } catch (error) {
        console.debug(`[SkillsMiddleware] registry list failed:`, error);
        loadedSkills = [];
      }
      return { skillsMetadata: loadedSkills };
    },

    wrapModelCall(request, handler) {
      const skillsMetadata: SkillMetadata[] =
        loadedSkills.length > 0
          ? loadedSkills
          : (request.state?.skillsMetadata as SkillMetadata[]) || [];

      const skillsLocations = formatSkillsLocations(promptSources);
      const skillsList = formatSkillsList(skillsMetadata, promptSources);

      const skillsSection = SKILLS_SYSTEM_PROMPT.replace(
        "{skills_locations}",
        skillsLocations,
      ).replace("{skills_list}", skillsList);

      const newSystemMessage = request.systemMessage.concat(skillsSection);
      return handler({ ...request, systemMessage: newSystemMessage });
    },
  });
}
