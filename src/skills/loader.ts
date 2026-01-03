/**
 * Skill loader for parsing and loading agent skills from SKILL.md files.
 *
 * This module implements Anthropic's agent skills pattern with YAML frontmatter parsing.
 * Each skill is a directory containing a SKILL.md file with:
 * - YAML frontmatter (name, description required)
 * - Markdown instructions for the agent
 * - Optional supporting files (scripts, configs, etc.)
 *
 * @example
 * ```markdown
 * ---
 * name: web-research
 * description: Structured approach to conducting thorough web research
 * ---
 *
 * # Web Research Skill
 *
 * ## When to Use
 * - User asks you to research a topic
 * ...
 * ```
 *
 * @see https://agentskills.io/specification
 */

import fs from "node:fs";
import path from "node:path";
import yaml from "yaml";

/** Maximum size for SKILL.md files (10MB) */
export const MAX_SKILL_FILE_SIZE = 10 * 1024 * 1024;

/** Agent Skills spec constraints */
export const MAX_SKILL_NAME_LENGTH = 64;
export const MAX_SKILL_DESCRIPTION_LENGTH = 1024;

/** Pattern for validating skill names per Agent Skills spec */
const SKILL_NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Pattern for extracting YAML frontmatter */
const FRONTMATTER_PATTERN = /^---\s*\n([\s\S]*?)\n---\s*\n/;

/**
 * Metadata for a skill per Agent Skills spec.
 * @see https://agentskills.io/specification
 */
export interface SkillMetadata {
  /** Name of the skill (max 64 chars, lowercase alphanumeric and hyphens) */
  name: string;

  /** Description of what the skill does (max 1024 chars) */
  description: string;

  /** Absolute path to the SKILL.md file */
  path: string;

  /** Source of the skill ('user' or 'project') */
  source: "user" | "project";

  /** Optional: License name or reference to bundled license file */
  license?: string;

  /** Optional: Environment requirements (max 500 chars) */
  compatibility?: string;

  /** Optional: Arbitrary key-value mapping for additional metadata */
  metadata?: Record<string, string>;

  /** Optional: Space-delimited list of pre-approved tools */
  allowedTools?: string;
}

/**
 * Options for listing skills.
 */
export interface ListSkillsOptions {
  /** Path to user-level skills directory */
  userSkillsDir?: string | null;

  /** Path to project-level skills directory */
  projectSkillsDir?: string | null;
}

/**
 * Result of skill name validation.
 */
interface ValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * Check if a path is safely contained within base_dir.
 *
 * This prevents directory traversal attacks via symlinks or path manipulation.
 * The function resolves both paths to their canonical form (following symlinks)
 * and verifies that the target path is within the base directory.
 *
 * @param targetPath - The path to validate
 * @param baseDir - The base directory that should contain the path
 * @returns True if the path is safely within baseDir, false otherwise
 */
function isSafePath(targetPath: string, baseDir: string): boolean {
  try {
    // Resolve both paths to their canonical form (follows symlinks)
    const resolvedPath = fs.realpathSync(targetPath);
    const resolvedBase = fs.realpathSync(baseDir);

    // Check if the resolved path is within the base directory
    return (
      resolvedPath.startsWith(resolvedBase + path.sep) ||
      resolvedPath === resolvedBase
    );
  } catch {
    // Error resolving paths (e.g., circular symlinks, too many levels)
    return false;
  }
}

/**
 * Validate skill name per Agent Skills spec.
 *
 * Requirements:
 * - Max 64 characters
 * - Lowercase alphanumeric and hyphens only (a-z, 0-9, -)
 * - Cannot start or end with hyphen
 * - No consecutive hyphens
 * - Must match parent directory name
 *
 * @param name - The skill name from YAML frontmatter
 * @param directoryName - The parent directory name
 * @returns Validation result with error message if invalid
 */
function validateSkillName(
  name: string,
  directoryName: string,
): ValidationResult {
  if (!name) {
    return { valid: false, error: "name is required" };
  }
  if (name.length > MAX_SKILL_NAME_LENGTH) {
    return { valid: false, error: "name exceeds 64 characters" };
  }
  // Pattern: lowercase alphanumeric, single hyphens between segments, no start/end hyphen
  if (!SKILL_NAME_PATTERN.test(name)) {
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
  return { valid: true };
}

/**
 * Parse YAML frontmatter from content.
 *
 * @param content - The file content
 * @returns Parsed frontmatter object, or null if parsing fails
 */
function parseFrontmatter(content: string): Record<string, unknown> | null {
  const match = content.match(FRONTMATTER_PATTERN);
  if (!match) {
    return null;
  }

  try {
    const parsed = yaml.parse(match[1]);
    return typeof parsed === "object" && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Parse YAML frontmatter from a SKILL.md file per Agent Skills spec.
 *
 * @param skillMdPath - Path to the SKILL.md file
 * @param source - Source of the skill ('user' or 'project')
 * @returns SkillMetadata with all fields, or null if parsing fails
 */
export function parseSkillMetadata(
  skillMdPath: string,
  source: "user" | "project",
): SkillMetadata | null {
  try {
    // Security: Check file size to prevent DoS attacks
    const stats = fs.statSync(skillMdPath);
    if (stats.size > MAX_SKILL_FILE_SIZE) {
      // eslint-disable-next-line no-console
      console.warn(
        `Skipping ${skillMdPath}: file too large (${stats.size} bytes)`,
      );
      return null;
    }

    const content = fs.readFileSync(skillMdPath, "utf-8");
    const frontmatter = parseFrontmatter(content);

    if (!frontmatter) {
      // eslint-disable-next-line no-console
      console.warn(`Skipping ${skillMdPath}: no valid YAML frontmatter found`);
      return null;
    }

    // Validate required fields
    const name = frontmatter.name;
    const description = frontmatter.description;

    if (!name || !description) {
      // eslint-disable-next-line no-console
      console.warn(
        `Skipping ${skillMdPath}: missing required 'name' or 'description'`,
      );
      return null;
    }

    // Validate name format per spec (warn but still load for backwards compatibility)
    const directoryName = path.basename(path.dirname(skillMdPath));
    const validation = validateSkillName(String(name), directoryName);
    if (!validation.valid) {
      // eslint-disable-next-line no-console
      console.warn(
        `Skill '${name}' in ${skillMdPath} does not follow Agent Skills spec: ${validation.error}. ` +
          "Consider renaming to be spec-compliant.",
      );
    }

    // Truncate description if too long (spec: max 1024 chars)
    let descriptionStr = String(description);
    if (descriptionStr.length > MAX_SKILL_DESCRIPTION_LENGTH) {
      // eslint-disable-next-line no-console
      console.warn(
        `Description exceeds ${MAX_SKILL_DESCRIPTION_LENGTH} chars in ${skillMdPath}, truncating`,
      );
      descriptionStr = descriptionStr.slice(0, MAX_SKILL_DESCRIPTION_LENGTH);
    }

    return {
      name: String(name),
      description: descriptionStr,
      path: skillMdPath,
      source,
      license: frontmatter.license ? String(frontmatter.license) : undefined,
      compatibility: frontmatter.compatibility
        ? String(frontmatter.compatibility)
        : undefined,
      metadata:
        frontmatter.metadata && typeof frontmatter.metadata === "object"
          ? (frontmatter.metadata as Record<string, string>)
          : undefined,
      allowedTools: frontmatter["allowed-tools"]
        ? String(frontmatter["allowed-tools"])
        : undefined,
    };
  } catch (error) {
    // eslint-disable-next-line no-console
    console.warn(`Error reading ${skillMdPath}: ${error}`);
    return null;
  }
}

/**
 * List all skills from a single skills directory (internal helper).
 *
 * Scans the skills directory for subdirectories containing SKILL.md files,
 * parses YAML frontmatter, and returns skill metadata.
 *
 * Skills are organized as:
 * ```
 * skills/
 * ├── skill-name/
 * │   ├── SKILL.md        # Required: instructions with YAML frontmatter
 * │   ├── script.py       # Optional: supporting files
 * │   └── config.json     # Optional: supporting files
 * ```
 *
 * @param skillsDir - Path to the skills directory
 * @param source - Source of the skills ('user' or 'project')
 * @returns List of skill metadata
 */
function listSkillsFromDir(
  skillsDir: string,
  source: "user" | "project",
): SkillMetadata[] {
  // Check if skills directory exists
  const expandedDir = skillsDir.startsWith("~")
    ? path.join(
        process.env.HOME || process.env.USERPROFILE || "",
        skillsDir.slice(1),
      )
    : skillsDir;

  if (!fs.existsSync(expandedDir)) {
    return [];
  }

  // Resolve base directory to canonical path for security checks
  let resolvedBase: string;
  try {
    resolvedBase = fs.realpathSync(expandedDir);
  } catch {
    // Can't resolve base directory, fail safe
    return [];
  }

  const skills: SkillMetadata[] = [];

  // Iterate through subdirectories
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(resolvedBase, { withFileTypes: true });
  } catch {
    return [];
  }

  for (const entry of entries) {
    const skillDir = path.join(resolvedBase, entry.name);

    // Security: Catch symlinks pointing outside the skills directory
    if (!isSafePath(skillDir, resolvedBase)) {
      continue;
    }

    if (!entry.isDirectory()) {
      continue;
    }

    // Look for SKILL.md file
    const skillMdPath = path.join(skillDir, "SKILL.md");
    if (!fs.existsSync(skillMdPath)) {
      continue;
    }

    // Security: Validate SKILL.md path is safe before reading
    if (!isSafePath(skillMdPath, resolvedBase)) {
      continue;
    }

    // Parse metadata
    const metadata = parseSkillMetadata(skillMdPath, source);
    if (metadata) {
      skills.push(metadata);
    }
  }

  return skills;
}

/**
 * List skills from user and/or project directories.
 *
 * When both directories are provided, project skills with the same name as
 * user skills will override them.
 *
 * @param options - Options specifying which directories to search
 * @returns Merged list of skill metadata from both sources, with project skills
 *          taking precedence over user skills when names conflict
 */
export function listSkills(options: ListSkillsOptions): SkillMetadata[] {
  const allSkills: Map<string, SkillMetadata> = new Map();

  // Load user skills first (foundation)
  if (options.userSkillsDir) {
    const userSkills = listSkillsFromDir(options.userSkillsDir, "user");
    for (const skill of userSkills) {
      allSkills.set(skill.name, skill);
    }
  }

  // Load project skills second (override/augment)
  if (options.projectSkillsDir) {
    const projectSkills = listSkillsFromDir(
      options.projectSkillsDir,
      "project",
    );
    for (const skill of projectSkills) {
      // Project skills override user skills with the same name
      allSkills.set(skill.name, skill);
    }
  }

  return Array.from(allSkills.values());
}
