/**
 * Skills module for deepagents.
 *
 * Public API:
 * - listSkills: List skills from user and/or project directories
 * - parseSkillMetadata: Parse metadata from a single SKILL.md file
 * - SkillMetadata: Type for skill metadata
 * - ListSkillsOptions: Type for listSkills options
 */

export {
  listSkills,
  parseSkillMetadata,
  MAX_SKILL_FILE_SIZE,
  MAX_SKILL_NAME_LENGTH,
  MAX_SKILL_DESCRIPTION_LENGTH,
} from "./loader.js";

export type { SkillMetadata, ListSkillsOptions } from "./loader.js";
