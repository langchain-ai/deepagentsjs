import type { SkillMetadata } from "./discovery.js";

/**
 * Full payload returned by `SkillProvider.load(name)`. The activation tool
 * uses `body`; the code interpreter uses `files`; `metadata` is provided
 * for callers that want to correlate without a second `list()` call.
 */
export interface LoadedSkill {
  /**
   * The same `SkillMetadata` record `list()` would have returned for this
   * skill, repeated here for caller convenience.
   */
  metadata: SkillMetadata;

  /**
   * Raw SKILL.md body with the YAML frontmatter block removed. Empty
   * string is valid (a SKILL.md may consist only of frontmatter).
   */
  body: string;

  /**
   * Source files keyed by POSIX-relative path under the skill directory.
   * Empty map is valid for prose-only skills.
   */
  files: Map<string, string>;
}

/**
 * Source-side contract for skills.
 *
 * Implementations decouple where skills come from (local filesystem, a
 * backend route, a future remote registry) from how they are consumed
 * (system-prompt discovery, code-interpreter module loading). The same
 * provider instance feeds both pipelines after being passed to
 * `createDeepAgent({ skills })`.
 *
 * Implementations should be cheap to construct. `list()` is the
 * lightweight discovery operation; `load(name)` is the expensive one and
 * returns full file contents.
 */
export interface SkillProvider {
  /**
   * Stable identifier used for diagnostic logging. Not user-facing.
   * Examples: `"fs:/path/to/skills"`, `"backend:/skills/user/"`.
   */
  readonly id: string;

  /**
   * Enumerate skills exposed by this provider, returning metadata only.
   * Implementations should treat this as cheap and side-effect free.
   */
  list(): Promise<SkillMetadata[]>;

  /**
   * Load the full payload for a skill by name. Throws when the skill is
   * unknown to this provider, the underlying source is unreadable, or
   * any validation fails (size cap, name format, traversal defenses).
   */
  load(name: string): Promise<LoadedSkill>;
}
