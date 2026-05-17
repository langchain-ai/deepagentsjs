import * as posix from "node:path/posix";

import type { AnyBackendProtocol } from "../backends/protocol.js";
import { adaptBackendProtocol } from "../backends/utils.js";

import {
  SKILL_MODULE_EXTENSIONS,
  listSkillsFromBackend,
  parseSkillMetadataFromContent,
} from "./discovery.js";
import type { SkillMetadata } from "./discovery.js";
import { MAX_SKILL_BUNDLE_BYTES } from "./filesystem-provider.js";
import type { LoadedSkill, SkillProvider } from "./provider.js";

/**
 * Matches the YAML frontmatter block at the head of a SKILL.md file.
 * The first capture group holds the frontmatter body between the
 * `---` delimiters.
 */
const FRONTMATTER_PATTERN = /^---\s*\n([\s\S]*?)\n---\s*\n/;

/**
 * Kebab-case identifier pattern enforced on skill names per the
 * agentskills.io spec.
 */
const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Construction options for `BackendSkillProvider`.
 */
export interface BackendSkillProviderOptions {
  /**
   * Already-resolved backend. This provider does not accept factories
   * directly; for factory-pattern backends, prefer the string-source
   * shape on `createDeepAgent({ skills: ["/path/"] })` which handles
   * resolution per-invocation.
   */
  backend: AnyBackendProtocol;

  /**
   * POSIX-style directory whose immediate children are skill directories.
   * Matches the shape of the legacy `sources: string[]` API.
   */
  sourcePath: string;

  /**
   * Optional stable identifier for diagnostics. Defaults to
   * `"backend:<sourcePath>"`.
   */
  id?: string;
}

/**
 * `SkillProvider` backed by an existing `BackendProtocolV2`.
 *
 * Reads `SKILL.md` and any code files under a configured source directory
 * through the backend's standard `ls` / `glob` / `read` / `downloadFiles`
 * operations. This is the canonical desugaring of the legacy
 * `skills: ["/skills/..."]` string-source API: each string entry becomes
 * one `BackendSkillProvider` instance.
 *
 * Use this when skills live in the same backend the agent reads its own
 * files from. For host-disk-only sources, prefer `FilesystemSkillProvider`.
 */
export class BackendSkillProvider implements SkillProvider {
  readonly id: string;

  private readonly backend: AnyBackendProtocol;
  private readonly sourcePath: string;

  constructor(opts: BackendSkillProviderOptions) {
    this.backend = opts.backend;
    this.sourcePath = opts.sourcePath;
    this.id = opts.id ?? `backend:${opts.sourcePath}`;
  }

  async list(): Promise<SkillMetadata[]> {
    return listSkillsFromBackend(this.backend, this.sourcePath);
  }

  async load(name: string): Promise<LoadedSkill> {
    if (!SKILL_NAME_PATTERN.test(name)) {
      throw new Error(
        `BackendSkillProvider: invalid skill name '${name}' (must be lowercase kebab-case)`,
      );
    }

    const skillDir = this.skillDirFor(name);
    const skillMdPath = `${skillDir}/SKILL.md`;
    const adapted = adaptBackendProtocol(this.backend);

    const skillMdContent = await readBackendFile(adapted, skillMdPath, name);
    const metadata = parseSkillMetadataFromContent(
      skillMdContent,
      skillMdPath,
      name,
    );
    if (metadata === null) {
      throw new Error(
        `BackendSkillProvider: '${name}' has invalid or missing SKILL.md frontmatter`,
      );
    }

    const body = stripFrontmatter(skillMdContent);
    const files = await collectBackendFiles(adapted, skillDir, name);

    return { metadata, body, files };
  }

  /**
   * Compose the skill's backend directory by appending `name` to the
   * configured `sourcePath`, normalizing the trailing slash. Used as the
   * root for `SKILL.md` and code-file reads for a given skill.
   */
  private skillDirFor(name: string): string {
    const normalized = this.sourcePath.endsWith("/")
      ? this.sourcePath
      : `${this.sourcePath}/`;
    return `${normalized}${name}`;
  }
}

/**
 * Read a single file through the backend, preferring `downloadFiles` when
 * available so binary-safe paths are used when the backend supports them.
 */
async function readBackendFile(
  adapted: ReturnType<typeof adaptBackendProtocol>,
  filePath: string,
  skillName: string,
): Promise<string> {
  if (adapted.downloadFiles !== undefined) {
    const responses = await adapted.downloadFiles([filePath]);
    if (responses.length !== 1) {
      throw new Error(
        `BackendSkillProvider: '${skillName}': download returned ${responses.length} responses for '${filePath}'`,
      );
    }
    return decodeDownloadResponse(responses[0], filePath, skillName);
  }

  const result = await adapted.read(filePath);
  if (result.error !== undefined && result.error !== null) {
    throw new Error(
      `BackendSkillProvider: '${skillName}': read failed for '${filePath}': ${result.error}`,
    );
  }
  if (typeof result.content !== "string") {
    throw new Error(
      `BackendSkillProvider: '${skillName}': '${filePath}' did not return text content`,
    );
  }
  return result.content;
}

/**
 * Decode a `FileDownloadResponse` to a UTF-8 string, throwing with a
 * skill-specific diagnostic on error or invalid encoding.
 */
function decodeDownloadResponse(
  response: { path: string; content: Uint8Array | null; error: string | null },
  filePath: string,
  skillName: string,
): string {
  if (response.error !== null || response.content === null) {
    const reason = response.error ?? "no content";
    throw new Error(
      `BackendSkillProvider: '${skillName}': failed to download '${filePath}': ${reason}`,
    );
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(response.content);
  } catch {
    throw new Error(
      `BackendSkillProvider: '${skillName}': file '${filePath}' is not valid UTF-8`,
    );
  }
}

/**
 * Enumerate the backend for code files under a skill directory, download
 * each, decode it, and assemble a relative-path-keyed source map. Enforces
 * the same per-skill byte cap as the filesystem provider.
 */
async function collectBackendFiles(
  adapted: ReturnType<typeof adaptBackendProtocol>,
  skillDir: string,
  skillName: string,
): Promise<Map<string, string>> {
  const paths = await enumerateCodeFiles(adapted, skillDir, skillName);
  if (paths.length === 0) {
    return new Map();
  }

  if (adapted.downloadFiles === undefined) {
    throw new Error(
      `BackendSkillProvider: '${skillName}': backend does not implement downloadFiles`,
    );
  }

  const responses = await adapted.downloadFiles(paths);
  const files = new Map<string, string>();
  let totalBytes = 0;

  for (const response of responses) {
    const source = decodeDownloadResponse(response, response.path, skillName);
    totalBytes += source.length;
    if (totalBytes > MAX_SKILL_BUNDLE_BYTES) {
      throw new Error(
        `BackendSkillProvider: '${skillName}': bundle exceeds ${MAX_SKILL_BUNDLE_BYTES} bytes`,
      );
    }

    const rel = posix.relative(skillDir, response.path);
    if (rel === "" || rel.startsWith("..")) {
      throw new Error(
        `BackendSkillProvider: '${skillName}': file '${response.path}' is not under '${skillDir}'`,
      );
    }
    files.set(rel, source);
  }

  return files;
}

/**
 * Run a `glob` per extension under the skill directory and return the
 * de-duplicated, sorted list of file paths, with test files excluded.
 */
async function enumerateCodeFiles(
  adapted: ReturnType<typeof adaptBackendProtocol>,
  skillDir: string,
  skillName: string,
): Promise<string[]> {
  const seen = new Set<string>();

  for (const ext of SKILL_MODULE_EXTENSIONS) {
    const result = await adapted.glob(`**/*${ext}`, skillDir);
    if (result.error !== undefined) {
      throw new Error(
        `BackendSkillProvider: '${skillName}': glob failed for '${skillDir}': ${result.error}`,
      );
    }
    for (const match of result.files ?? []) {
      if (isTestPath(match.path)) {
        continue;
      }
      seen.add(match.path);
    }
  }

  return [...seen].sort();
}

/**
 * True when a backend-path looks like a test or spec file. Test files
 * are excluded from a skill's runtime bundle so they don't get shipped
 * into the code interpreter.
 */
function isTestPath(filePath: string): boolean {
  const base = filePath.split("/").pop() ?? filePath;
  const stem = base.replace(/\.[^.]+$/, "");
  return stem.endsWith(".test") || stem.endsWith(".spec");
}

/**
 * Strip the YAML frontmatter block from the head of a SKILL.md file. If
 * no frontmatter block is present, returns the input verbatim.
 */
function stripFrontmatter(raw: string): string {
  const match = raw.match(FRONTMATTER_PATTERN);
  if (match === null) {
    return raw;
  }
  return raw.slice(match[0].length);
}
