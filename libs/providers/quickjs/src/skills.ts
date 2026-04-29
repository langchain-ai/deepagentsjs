import * as posix from "node:path/posix";

import {
  adaptBackendProtocol,
  BackendProtocolV2,
  type AnyBackendProtocol,
  type FileDownloadResponse,
  type FileInfo,
  type SkillMetadata,
} from "deepagents";

import { stripTypeSyntax } from "./transform.js";

/**
 * File extensions the loader will enumerate from a skill directory.
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
 * Hard cap on total bytes pulled for one skill's bundle (1 MiB).
 */
export const MAX_SKILL_BUNDLE_BYTES = 1 * 1024 * 1024;

/**
 * Validates a skill name against the spec's kebab-case rule.
 */
const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Matches `"@/skills/<name>"` or `'@/skills/<name>'` references in source.
 * Template literals and computed specifiers are not caught.
 */
const SKILL_SPECIFIER_RE = /["']@\/skills\/([a-z0-9]+(?:-[a-z0-9]+)*)["']/g;

/**
 * Install-ready state for a single skill, produced by `loadSkill`.
 */
export interface LoadedSkill {
  /**
   * Spec-validated kebab-case skill name.
   */
  name: string;

  /**
   * Bare specifier the skill installs under: `"@/skills/<name>"`.
   */
  specifier: string;

  /**
   * Relative POSIX path of the entrypoint file (e.g. `"index.ts"`).
   */
  entryRel: string;

  /**
   * File contents keyed by relative POSIX path, with TS syntax stripped.
   */
  files: Map<string, string>;
}

/**
 * List every code-extension file under `skillDir` (recursive).
 */
async function enumerateCodeFiles(
  backend: BackendProtocolV2,
  skillDir: string,
  skillName: string,
): Promise<string[]> {
  const seen = new Set<string>();
  for (const ext of SKILL_MODULE_EXTENSIONS) {
    const result = await backend.glob(`**/*${ext}`, skillDir);
    if (result.error !== undefined) {
      throw new Error(
        `Skill '${skillName}': failed to list '${skillDir}': ${result.error}`,
      );
    }

    const matches: FileInfo[] = result.files ?? [];
    for (const match of matches) {
      seen.add(match.path);
    }
  }

  return [...seen].sort();
}

/**
 * Decode download responses into [path, source] pairs.
 */
function decodeFiles(
  responses: FileDownloadResponse[],
  skillName: string,
): Array<[string, string]> {
  const decoder = new TextDecoder("utf-8", { fatal: true });

  const pairs: Array<[string, string]> = [];
  for (const response of responses) {
    if (response.error !== null || response.content === null) {
      throw new Error(
        `Skill '${skillName}': failed to download '${response.path}': ${response.error ?? "no content"}`,
      );
    }

    let source: string;
    try {
      source = decoder.decode(response.content);
    } catch {
      throw new Error(
        `Skill '${skillName}': file '${response.path}' is not valid UTF-8`,
      );
    }

    pairs.push([response.path, source]);
  }

  return pairs;
}

/**
 * Throws an Error when the total decoded size of all files exceeds
 * `MAX_SKILL_BUNDLE_BYTES`. Counts characters rather than bytes, which
 * over-counts multi-byte UTF-8. Intentionally errs toward rejection.
 */
function validateBundleSize(
  pairs: Array<[string, string]>,
  skillName: string,
): void {
  let total = 0;
  for (const [, source] of pairs) {
    total += source.length;
  }

  if (total > MAX_SKILL_BUNDLE_BYTES) {
    throw new Error(
      `Skill '${skillName}': bundle exceeds ${MAX_SKILL_BUNDLE_BYTES} bytes (total ${total})`,
    );
  }
}

/**
 * Express `absolutePath` as a POSIX-relative path under `skillDir`.
 * Throws an Error if the path escapes the skill directory which indicates
 * a backend bug, not a user error.
 */
function relativeUnder(
  skillDir: string,
  absolutePath: string,
  skillName: string,
): string {
  const rel = posix.relative(skillDir, absolutePath);
  if (rel === "" || rel.startsWith("..")) {
    throw new Error(
      `Skill '${skillName}': file ${absolutePath} is not under '${skillDir}'`,
    );
  }
  return rel;
}

/**
 * Build the relative-path → source map, applying `stripTypeSyntax` to each file.
 */
function buildFilesMap(
  skillDir: string,
  entryRel: string,
  pairs: Array<[string, string]>,
  skillName: string,
): Map<string, string> {
  const files = new Map<string, string>();
  let entryPresent = false;

  for (const [absPath, source] of pairs) {
    const rel = relativeUnder(skillDir, absPath, skillName);
    files.set(rel, stripTypeSyntax(source));
    if (rel === entryRel) {
      entryPresent = true;
    }
  }

  if (!entryPresent) {
    throw new Error(
      `Skill '${skillName}': module path '${entryRel}' did not match any file in the skill directory`,
    );
  }

  return files;
}

/**
 * Build a `LoadedSkill` from a skill's metadata and a backend handle.
 *
 * Enumerates code files under the skill directory, downloads them,
 * strips TypeScript syntax, and validates the entrypoint is present.
 */
export async function loadSkill(
  metadata: SkillMetadata,
  backend: AnyBackendProtocol,
): Promise<LoadedSkill> {
  const name = metadata.name;

  if (!SKILL_NAME_RE.test(name)) {
    throw new Error(
      `Skill name '${name}' is not a valid kebab-case identifier`,
    );
  }

  const entryRel = metadata.module;
  if (entryRel === undefined || entryRel === "") {
    throw new Error(
      `Skill '${name}' has no 'module' frontmatter key - only skills with a declared entrypoint are installable`,
    );
  }

  const adapted = adaptBackendProtocol(backend);
  if (adapted.downloadFiles === undefined) {
    throw new Error(
      `Skill '${name}': backend does not implement downloadFiles`,
    );
  }

  const skillDir = posix.dirname(metadata.path);
  const codeFiles = await enumerateCodeFiles(adapted, skillDir, name);
  if (codeFiles.length === 0) {
    throw new Error(`Skill '${name}': no JS/TS files under '${skillDir}'`);
  }

  const responses = await adapted.downloadFiles(codeFiles);
  const filePairs = decodeFiles(responses, name);
  validateBundleSize(filePairs, name);

  const files = buildFilesMap(skillDir, entryRel, filePairs, name);
  return {
    name,
    specifier: `@/skills/${name}`,
    entryRel,
    files,
  };
}

/**
 * Extract skill names referenced by `"@/skills/<name>"` literals in source.
 *
 * Used as a pre-eval scan so the middleware can surface `SkillNotAvailable`
 * before evaluation starts. Dynamic imports with computed specifiers are
 * not detected.
 */
export function scanSkillReferences(source: string): Set<string> {
  const names = new Set<string>();

  const matches = source.matchAll(SKILL_SPECIFIER_RE);
  for (const match of matches) {
    names.add(match[1]);
  }

  return names;
}
