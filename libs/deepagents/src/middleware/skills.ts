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
import { resolveBackend } from "../backends/protocol.js";
import type { StateBackend } from "../backends/state.js";
import type { BaseStore } from "@langchain/langgraph-checkpoint";
import { filesValue } from "../values.js";
import { DEFAULT_READ_LINE_LIMIT } from "./fs.js";

import type { SkillMetadata, SkillMetadataEntry } from "../skills/discovery.js";
import {
  SkillMetadataEntrySchema,
  listSkillsFromBackend,
} from "../skills/discovery.js";

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
 * Line-read limit hint baked into the system prompt for the legacy
 * `read_file`-driven activation flow. Phase 4 retires the read_file
 * pattern; until then this stays so the existing prompt keeps working.
 */
export const DEFAULT_SKILL_READ_LINE_LIMIT = 1000;

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
  sources: string[];
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
  2. **Read the skill's full instructions**: Use \`read_file\` on the path shown in the skill list above.
     Pass \`limit=${DEFAULT_SKILL_READ_LINE_LIMIT}\` since the default of ${DEFAULT_READ_LINE_LIMIT} lines is too small for most skill files.
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
  const { backend, sources } = options;

  // Closure variable so wrapModelCall sees what beforeAgent loaded, even
  // before the state update propagates.
  let loadedSkills: SkillMetadata[] = [];

  return createMiddleware({
    name: "SkillsMiddleware",
    stateSchema: SkillsStateSchema,

    async beforeAgent(state) {
      if (loadedSkills.length > 0) {
        return undefined;
      }
      const restored = restoreFromState(state);
      if (restored !== null) {
        loadedSkills = restored;
        return undefined;
      }

      loadedSkills = await discoverFromSources(backend, sources, state);
      return { skillsMetadata: loadedSkills };
    },

    wrapModelCall(request, handler) {
      const skillsMetadata = currentSkillsMetadata(loadedSkills, request);
      const skillsLocations = formatSkillsLocations(sources);
      const skillsList = formatSkillsList(skillsMetadata, sources);

      const skillsSection = SKILLS_SYSTEM_PROMPT.replace(
        "{skills_locations}",
        skillsLocations,
      ).replace("{skills_list}", skillsList);

      const newSystemMessage = request.systemMessage.concat(skillsSection);
      return handler({ ...request, systemMessage: newSystemMessage });
    },
  });
}

/**
 * Pull skills back out of state on checkpoint restore so the middleware
 * doesn't re-run discovery in resumed conversations.
 */
function restoreFromState(state: unknown): SkillMetadata[] | null {
  const candidate = state as { skillsMetadata?: unknown };
  if (
    candidate !== null &&
    candidate !== undefined &&
    Array.isArray(candidate.skillsMetadata) &&
    candidate.skillsMetadata.length > 0
  ) {
    return candidate.skillsMetadata as SkillMetadata[];
  }
  return null;
}

/**
 * Return closure-cached metadata when populated, falling back to state
 * for the checkpoint-restore case.
 */
function currentSkillsMetadata(
  loaded: SkillMetadata[],
  request: { state?: { skillsMetadata?: SkillMetadata[] } },
): SkillMetadata[] {
  if (loaded.length > 0) {
    return loaded;
  }
  return request.state?.skillsMetadata ?? [];
}

/**
 * Run skill discovery across every configured source. Per-source
 * failures are logged and skipped so one broken source doesn't take
 * down discovery for the others. Later sources override earlier ones
 * on name collision.
 */
async function discoverFromSources(
  backend: SkillsMiddlewareOptions["backend"],
  sources: string[],
  state: unknown,
): Promise<SkillMetadata[]> {
  const resolvedBackend = await resolveBackend(backend, { state });
  const merged = new Map<string, SkillMetadata>();

  for (const sourcePath of sources) {
    try {
      const skills = await listSkillsFromBackend(resolvedBackend, sourcePath);
      for (const skill of skills) {
        merged.set(skill.name, skill);
      }
    } catch (error) {
      console.debug(
        `[SkillsMiddleware] Failed to load skills from ${sourcePath}:`,
        error,
      );
    }
  }

  return [...merged.values()];
}
