/**
 * Skills module for deepagents.
 *
 * Public API:
 * - listSkills: List skills from user and/or project directories
 * - parseSkillMetadata: Parse metadata from a single SKILL.md file
 * - SkillMetadata: Type for skill metadata
 * - ListSkillsOptions: Type for listSkills options
 */

// Legacy filesystem-only loader. Kept for back-compat — the package
// index re-exports `SkillMetadata` from this file as `LoaderSkillMetadata`.
export { listSkills, parseSkillMetadata } from "./loader.js";
export type {
  SkillMetadata as LoaderSkillMetadata,
  ListSkillsOptions,
} from "./loader.js";

// SkillProvider abstraction.
export type { SkillProvider, LoadedSkill } from "./provider.js";

// Discovery primitives shared by middleware and providers.
export type { SkillMetadata, SkillMetadataEntry } from "./discovery.js";
export {
  parseSkillMetadataFromContent,
  listSkillsFromBackend,
  SKILL_MODULE_EXTENSIONS,
  MAX_SKILL_FILE_SIZE,
  MAX_SKILL_NAME_LENGTH,
  MAX_SKILL_DESCRIPTION_LENGTH,
} from "./discovery.js";

export {
  FilesystemSkillProvider,
  MAX_SKILL_BUNDLE_BYTES,
  type FilesystemSkillProviderOptions,
} from "./filesystem-provider.js";
export {
  BackendSkillProvider,
  type BackendSkillProviderOptions,
} from "./backend-provider.js";
