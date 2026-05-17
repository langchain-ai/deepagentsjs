import yaml from "yaml";
import { z } from "zod";

import type { AnyBackendProtocol } from "../backends/protocol.js";
import { adaptBackendProtocol } from "../backends/utils.js";

/**
 * Maximum permitted size of a SKILL.md file. Hard cap to keep a malformed
 * skill source from exhausting memory during parse.
 */
export const MAX_SKILL_FILE_SIZE = 10 * 1024 * 1024;

/**
 * Maximum permitted skill-name length, per the agentskills.io spec.
 */
export const MAX_SKILL_NAME_LENGTH = 64;

/**
 * Maximum permitted description length, per the agentskills.io spec.
 * Descriptions longer than this are truncated rather than rejected.
 */
export const MAX_SKILL_DESCRIPTION_LENGTH = 1024;

/**
 * Maximum permitted compatibility-string length, per the agentskills.io
 * spec.
 */
export const MAX_SKILL_COMPATIBILITY_LENGTH = 500;

/**
 * File extensions that may appear as a skill's importable entrypoint.
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

/**
 * Skill metadata parsed from the YAML frontmatter of a SKILL.md file.
 * Matches the agentskills.io specification, with one back-compat extension:
 * the top-level `module:` field (used by pre-spec skills like early swarm)
 * is recognized but mapped through `metadata.entrypoint` going forward.
 */
export interface SkillMetadata {
  /**
   * Spec-validated kebab-case identifier for the skill. Used to address
   * the skill at activation and import time.
   */
  name: string;

  /**
   * Human-readable description shown to the agent during discovery, so the
   * agent can decide whether the skill applies to the user's task.
   */
  description: string;

  /**
   * Source-side path the skill's SKILL.md came from. Used for diagnostics
   * and as the address backend-sourced skills are read through.
   */
  path: string;

  /**
   * Optional license name or reference to a bundled license file.
   */
  license?: string | null;

  /**
   * Optional environment-requirement string. Capped at
   * `MAX_SKILL_COMPATIBILITY_LENGTH` characters.
   */
  compatibility?: string | null;

  /**
   * Open key-value extension point per the spec. Used to carry the
   * QuickJS entrypoint pointer (`metadata.entrypoint`) and any other
   * skill-specific configuration.
   */
  metadata?: Record<string, string>;

  /**
   * Pre-approved tool names for use during this skill. Experimental.
   */
  allowedTools?: string[];

  /**
   * Legacy pointer to a JS/TS entrypoint, relative to the skill directory.
   * Spec-aligned skills should use `metadata.entrypoint` instead;
   * `module` stays parseable for back-compat with pre-spec skills.
   */
  module?: string;
}

/**
 * Zod schema describing a single skill-metadata entry. Used by the
 * `SkillsMiddleware` state schema so per-subagent updates can be reduced
 * safely.
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

export type SkillMetadataEntry = z.infer<typeof SkillMetadataEntrySchema>;

/**
 * Parse the YAML frontmatter at the head of a SKILL.md file into a
 * `SkillMetadata` record. Returns `null` and emits a console warning when
 * the file is too large, the frontmatter is missing or malformed, or any
 * required field is absent.
 *
 * @param content   Raw bytes of the SKILL.md file, decoded as UTF-8.
 * @param skillPath Absolute or backend-relative path of the SKILL.md file,
 *                  used for diagnostic messages and the returned `path`
 *                  field.
 * @param dirName   Name of the parent directory. Used to verify the spec
 *                  rule that frontmatter `name` matches the directory.
 */
export function parseSkillMetadataFromContent(
  content: string,
  skillPath: string,
  dirName: string,
): SkillMetadata | null {
  if (content.length > MAX_SKILL_FILE_SIZE) {
    console.warn(
      `Skipping ${skillPath}: content too large (${content.length} bytes)`,
    );
    return null;
  }

  const frontmatterPattern = /^---\s*\n([\s\S]*?)\n---\s*\n/;
  const match = content.match(frontmatterPattern);
  if (!match) {
    console.warn(`Skipping ${skillPath}: no valid YAML frontmatter found`);
    return null;
  }

  let frontmatterData: Record<string, unknown>;
  try {
    frontmatterData = yaml.parse(match[1]);
  } catch (e) {
    console.warn(`Invalid YAML in ${skillPath}:`, e);
    return null;
  }

  if (!frontmatterData || typeof frontmatterData !== "object") {
    console.warn(`Skipping ${skillPath}: frontmatter is not a mapping`);
    return null;
  }

  const name = String(frontmatterData.name ?? "").trim();
  const description = String(frontmatterData.description ?? "").trim();
  if (!name || !description) {
    console.warn(
      `Skipping ${skillPath}: missing required 'name' or 'description'`,
    );
    return null;
  }

  const validation = validateSkillName(name, dirName);
  if (!validation.valid) {
    console.warn(
      `Skill '${name}' in ${skillPath} does not follow Agent Skills specification: ${validation.error}. Consider renaming for spec compliance.`,
    );
  }

  let descriptionStr = description;
  if (descriptionStr.length > MAX_SKILL_DESCRIPTION_LENGTH) {
    console.warn(
      `Description exceeds ${MAX_SKILL_DESCRIPTION_LENGTH} characters in ${skillPath}, truncating`,
    );
    descriptionStr = descriptionStr.slice(0, MAX_SKILL_DESCRIPTION_LENGTH);
  }

  const allowedTools = parseAllowedTools(frontmatterData["allowed-tools"]);
  const compatibilityStr = parseCompatibility(
    frontmatterData.compatibility,
    skillPath,
  );

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
 * Parse the `allowed-tools` frontmatter value. Supports both YAML lists
 * and space-delimited strings.
 */
function parseAllowedTools(raw: unknown): string[] {
  if (!raw) {
    return [];
  }
  if (Array.isArray(raw)) {
    return raw.map((t) => String(t).trim()).filter(Boolean);
  }
  return String(raw).split(/\s+/).filter(Boolean);
}

/**
 * Parse and truncate the `compatibility` frontmatter value. Returns `null`
 * when absent or empty.
 */
function parseCompatibility(raw: unknown, skillPath: string): string | null {
  const trimmed = String(raw ?? "").trim();
  if (trimmed === "") {
    return null;
  }
  if (trimmed.length > MAX_SKILL_COMPATIBILITY_LENGTH) {
    console.warn(
      `Compatibility exceeds ${MAX_SKILL_COMPATIBILITY_LENGTH} characters in ${skillPath}, truncating`,
    );
    return trimmed.slice(0, MAX_SKILL_COMPATIBILITY_LENGTH);
  }
  return trimmed;
}

/**
 * Validate a frontmatter `name` value against the agentskills.io spec.
 *
 * Constraints:
 *
 * - 1-64 characters
 * - Unicode lowercase alphanumeric and hyphens only
 * - Must not start or end with `-`
 * - Must not contain consecutive `--`
 * - Must match the parent directory name containing the `SKILL.md` file
 */
export function validateSkillName(
  name: string,
  dirName: string,
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
    if (c === "-") {
      continue;
    }
    if (/\p{Ll}/u.test(c) || /\p{Nd}/u.test(c)) {
      continue;
    }
    return {
      valid: false,
      error: "name must be lowercase alphanumeric with single hyphens only",
    };
  }
  if (name !== dirName) {
    return {
      valid: false,
      error: `name '${name}' must match directory name '${dirName}'`,
    };
  }
  return { valid: true, error: "" };
}

/**
 * Normalize the open-ended `metadata` field from YAML into a
 * `Record<string, string>`. Coerces non-string values to strings and drops
 * arrays/null/non-objects with a warning.
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
 * Normalize the legacy `module` frontmatter key into a skill-relative
 * POSIX path. Rejects absolute paths, traversal sequences, declaration
 * files, and unsupported extensions. Returns `undefined` for any
 * unparseable value so the skill degrades to prose-only.
 */
export function validateModulePath(raw: unknown): string | undefined {
  if (raw === null || raw === undefined) {
    return undefined;
  }
  if (typeof raw !== "string") {
    return undefined;
  }

  const stripped = raw.trim();
  if (stripped === "") {
    return undefined;
  }

  const normalized = stripped.startsWith("./") ? stripped.slice(2) : stripped;

  if (normalized.startsWith("/")) {
    return undefined;
  }
  if (
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.includes("/../") ||
    normalized.endsWith("/..")
  ) {
    return undefined;
  }
  if (
    normalized.endsWith(".d.ts") ||
    normalized.endsWith(".d.mts") ||
    normalized.endsWith(".d.cts")
  ) {
    return undefined;
  }
  if (!endsWithModuleExtension(normalized)) {
    return undefined;
  }

  return normalized;
}

/**
 * Returns true when `value` ends with one of `SKILL_MODULE_EXTENSIONS`.
 * Private helper for `validateModulePath`; not exported because no other
 * file in the codebase needs it.
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
 * Enumerate skills under a backend-rooted directory. Lists subdirectories
 * of `sourcePath`, reads each `<dir>/SKILL.md`, parses frontmatter, and
 * returns the resulting `SkillMetadata` records. Quietly skips
 * subdirectories with missing or malformed SKILL.md files.
 *
 * @param backend     Already-resolved backend instance.
 * @param sourcePath  POSIX-style directory whose immediate children are
 *                    skill directories.
 */
export async function listSkillsFromBackend(
  backend: AnyBackendProtocol,
  sourcePath: string,
): Promise<SkillMetadata[]> {
  const adapted = adaptBackendProtocol(backend);
  const pathSep = sourcePath.includes("\\") ? "\\" : "/";
  const normalizedPath =
    sourcePath.endsWith("/") || sourcePath.endsWith("\\")
      ? sourcePath
      : `${sourcePath}${pathSep}`;

  const entries = await listDirectories(adapted, normalizedPath);
  const skills: SkillMetadata[] = [];

  for (const entry of entries) {
    const skillMdPath = `${normalizedPath}${entry}${pathSep}SKILL.md`;
    const content = await readSkillMdFromBackend(adapted, skillMdPath);
    if (content === null) {
      continue;
    }
    const metadata = parseSkillMetadataFromContent(content, skillMdPath, entry);
    if (metadata !== null) {
      skills.push(metadata);
    }
  }

  return skills;
}

/**
 * List immediate subdirectory names under `normalizedPath`. Returns an
 * empty list when the directory is missing or unreadable.
 */
async function listDirectories(
  adapted: ReturnType<typeof adaptBackendProtocol>,
  normalizedPath: string,
): Promise<string[]> {
  try {
    const lsResult = await adapted.ls(normalizedPath);
    if (lsResult.error || !lsResult.files) {
      return [];
    }
    return lsResult.files
      .filter((info) => info.is_dir === true)
      .map((info) => {
        const name = info.path
          .replace(/[/\\]$/, "")
          .split(/[/\\]/)
          .pop();
        return name ?? "";
      })
      .filter((name) => name !== "");
  } catch {
    return [];
  }
}

/**
 * Read a single SKILL.md from the backend, preferring `downloadFiles` for
 * binary-safe reads and falling back to `read`. Returns `null` for any
 * error so callers can skip the skill silently.
 */
async function readSkillMdFromBackend(
  adapted: ReturnType<typeof adaptBackendProtocol>,
  skillMdPath: string,
): Promise<string | null> {
  if (adapted.downloadFiles) {
    const results = await adapted.downloadFiles([skillMdPath]);
    if (results.length !== 1) {
      return null;
    }
    const response = results[0];
    if (response.error != null || response.content == null) {
      return null;
    }
    return new TextDecoder().decode(response.content);
  }

  const readResult = await adapted.read(skillMdPath);
  if (readResult.error) {
    return null;
  }
  if (typeof readResult.content !== "string") {
    return null;
  }
  return readResult.content;
}
