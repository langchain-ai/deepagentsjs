import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import { parseSkillMetadataFromContent } from "./discovery.js";
import { SKILL_MODULE_EXTENSIONS } from "./discovery.js";
import type { SkillMetadata } from "./discovery.js";
import type { LoadedSkill, SkillProvider } from "./provider.js";

/**
 * Hard cap on total source bytes across all files in a single skill's
 * bundle. Mirrors the cap enforced by the code interpreter's skill loader
 * so we reject oversized bundles at the source rather than later.
 */
export const MAX_SKILL_BUNDLE_BYTES = 1 * 1024 * 1024;

/**
 * Matches the YAML frontmatter block at the head of a SKILL.md file.
 * The first capture group holds the frontmatter body between the
 * `---` delimiters.
 */
const FRONTMATTER_PATTERN = /^---\s*\n([\s\S]*?)\n---\s*\n/;

/**
 * Whether the running platform supports `O_NOFOLLOW`. Used to opt in to
 * symlink rejection at `open()` time when available; on platforms that
 * don't expose the flag we fall back to a plain read.
 */
const SUPPORTS_NOFOLLOW = fs.constants.O_NOFOLLOW !== undefined;

/**
 * File-stem suffixes treated as test files. Files ending in `.test.<ext>`
 * or `.spec.<ext>` are excluded from a skill's runtime bundle.
 */
const TEST_FILE_SUFFIXES = [".test", ".spec"];

/**
 * Kebab-case identifier pattern enforced on skill names per the
 * agentskills.io spec.
 */
const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Construction options for `FilesystemSkillProvider`.
 */
export interface FilesystemSkillProviderOptions {
  /**
   * Absolute or process-relative path to a directory whose immediate
   * children are skill directories. Each child directory containing a
   * `SKILL.md` is treated as a single skill.
   */
  root: string;

  /**
   * Optional stable identifier for diagnostics. Defaults to
   * `"fs:<absoluteRoot>"`.
   */
  id?: string;
}

/**
 * `SkillProvider` backed by a directory on the host filesystem.
 *
 * Expected layout under `root`:
 *
 *     <root>/
 *       <skill-name>/
 *         SKILL.md
 *         scripts/        (optional, for skills with executable entrypoints)
 *           index.ts
 *           ...
 *
 * Defenses applied: kebab-case name validation, refusal to traverse outside
 * `root`, symlink rejection via `O_NOFOLLOW` when available, per-skill
 * bundle-size cap.
 *
 * Not suitable for deployments where the skill source doesn't live on the
 * same filesystem the process can reach. Use `BackendSkillProvider` or a
 * remote provider in those cases.
 */
export class FilesystemSkillProvider implements SkillProvider {
  readonly id: string;

  private readonly rootAbs: string;

  constructor(opts: FilesystemSkillProviderOptions) {
    this.rootAbs = path.resolve(opts.root);
    this.id = opts.id ?? `fs:${this.rootAbs}`;
  }

  async list(): Promise<SkillMetadata[]> {
    const entries = await this.readRootEntries();
    const skills: SkillMetadata[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      const metadata = await this.tryParseSkill(entry.name);
      if (metadata !== null) {
        skills.push(metadata);
      }
    }

    return skills;
  }

  async load(name: string): Promise<LoadedSkill> {
    this.assertSafeSkillName(name);

    const skillDir = path.join(this.rootAbs, name);
    this.assertUnderRoot(skillDir, name);

    const skillMdPath = path.join(skillDir, "SKILL.md");
    const raw = await this.readSkillMd(skillMdPath);

    const metadata = parseSkillMetadataFromContent(raw, skillMdPath, name);
    if (metadata === null) {
      throw new Error(
        `FilesystemSkillProvider: '${name}' has invalid or missing SKILL.md frontmatter`,
      );
    }

    const body = stripFrontmatter(raw);
    const files = await this.collectSourceFiles(skillDir, name);

    return { metadata, body, files };
  }

  /**
   * `readdir` the configured root, returning an empty list if the root
   * does not exist or is unreadable. Surfacing nothing is preferable to
   * throwing during discovery — agents using this provider should still
   * start up cleanly when the directory hasn't been created yet.
   */
  private async readRootEntries(): Promise<fs.Dirent[]> {
    try {
      return await fsp.readdir(this.rootAbs, { withFileTypes: true });
    } catch {
      return [];
    }
  }

  /**
   * Attempt to parse a single child directory as a skill. Returns `null`
   * (and does not throw) when the child has no SKILL.md or its frontmatter
   * is malformed, so a single bad skill doesn't poison discovery.
   */
  private async tryParseSkill(dirName: string): Promise<SkillMetadata | null> {
    const skillDir = path.join(this.rootAbs, dirName);
    const skillMdPath = path.join(skillDir, "SKILL.md");

    let content: string;
    try {
      content = await this.readFileNoFollow(skillMdPath);
    } catch {
      return null;
    }

    return parseSkillMetadataFromContent(content, skillMdPath, dirName);
  }

  /**
   * Walk the skill directory recursively and return its source files keyed
   * by skill-relative POSIX path.
   *
   * Skips entries that aren't regular code files (symlinks, non-code
   * extensions, test files). Stops with an error once the accumulated
   * decoded size exceeds {@link MAX_SKILL_BUNDLE_BYTES}.
   *
   * @param skillDir   Absolute path to the skill's directory under `rootAbs`.
   * @param skillName  Skill name used in diagnostic messages and for the
   *                   under-root containment check on each visited entry.
   */
  private async collectSourceFiles(
    skillDir: string,
    skillName: string,
  ): Promise<Map<string, string>> {
    const files = new Map<string, string>();
    let totalBytes = 0;

    const walk = async (dirAbs: string): Promise<void> => {
      const entries = await this.tryReadDir(dirAbs);
      for (const entry of entries) {
        const entryAbs = path.join(dirAbs, entry.name);
        this.assertUnderRoot(entryAbs, skillName);

        if (entry.isSymbolicLink()) {
          continue;
        }
        if (entry.isDirectory()) {
          await walk(entryAbs);
          continue;
        }
        if (!entry.isFile()) {
          continue;
        }
        if (!hasCodeExtension(entry.name)) {
          continue;
        }
        if (isTestFile(entry.name)) {
          continue;
        }

        const source = await this.readFileNoFollow(entryAbs);
        totalBytes += source.length;
        if (totalBytes > MAX_SKILL_BUNDLE_BYTES) {
          throw new Error(
            `FilesystemSkillProvider: skill '${skillName}' bundle exceeds ${MAX_SKILL_BUNDLE_BYTES} bytes`,
          );
        }

        const rel = path.relative(skillDir, entryAbs).split(path.sep).join("/");
        files.set(rel, source);
      }
    };

    await walk(skillDir);
    return files;
  }

  /**
   * `readdir` a directory and return its entries, or an empty array if the
   * directory does not exist or is unreadable. Used during the recursive
   * walk so a single missing subdirectory doesn't abort collection of the
   * rest of the skill bundle.
   */
  private async tryReadDir(absPath: string): Promise<fs.Dirent[]> {
    try {
      return await fsp.readdir(absPath, { withFileTypes: true });
    } catch {
      return [];
    }
  }

  /**
   * Read the SKILL.md for a named skill with the same anti-symlink posture
   * as every other read. Wraps the error so callers get a useful diagnostic
   * that includes the skill name.
   */
  private async readSkillMd(skillMdPath: string): Promise<string> {
    try {
      return await this.readFileNoFollow(skillMdPath);
    } catch (err) {
      const errno = err as NodeJS.ErrnoException;
      const detail = errno.message ?? errno.code ?? "unknown error";
      throw new Error(
        `FilesystemSkillProvider: cannot read '${skillMdPath}': ${detail}`,
      );
    }
  }

  /**
   * Read a single file with `O_NOFOLLOW` set when the platform supports it,
   * so symlinks raise rather than silently leaking content from outside the
   * root.
   */
  private async readFileNoFollow(absPath: string): Promise<string> {
    const flags = SUPPORTS_NOFOLLOW
      ? fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW
      : fs.constants.O_RDONLY;

    const handle = await fsp.open(absPath, flags);
    try {
      const buf = await handle.readFile();
      return new TextDecoder("utf-8", { fatal: true }).decode(buf);
    } finally {
      await handle.close();
    }
  }

  /**
   * Throw if `absPath` resolves outside the configured root. Final
   * defense against directory traversal — the kebab-case skill-name
   * pattern blocks the obvious cases, but any path manipulation between
   * the name check and a read is re-verified through this method.
   */
  private assertUnderRoot(absPath: string, skillName: string): void {
    const rel = path.relative(this.rootAbs, absPath);
    const escapes = rel === "" || rel.startsWith("..") || path.isAbsolute(rel);
    if (escapes) {
      throw new Error(
        `FilesystemSkillProvider: path for skill '${skillName}' escapes root`,
      );
    }
  }

  /**
   * Throw if `name` is not a non-empty kebab-case identifier no longer
   * than the spec's 64-character maximum. Run before any path is built
   * from the name so traversal sequences (`..`, `/`, `\`) can never reach
   * `path.join`.
   */
  private assertSafeSkillName(name: string): void {
    const safe =
      typeof name === "string" &&
      name.length > 0 &&
      name.length <= 64 &&
      SKILL_NAME_PATTERN.test(name);
    if (!safe) {
      throw new Error(
        `FilesystemSkillProvider: invalid skill name '${name}' (must be lowercase kebab-case)`,
      );
    }
  }
}

/**
 * Strip the YAML frontmatter block from the head of a SKILL.md file. If no
 * frontmatter block is present, returns the input verbatim.
 */
function stripFrontmatter(raw: string): string {
  const match = raw.match(FRONTMATTER_PATTERN);
  if (match === null) {
    return raw;
  }
  return raw.slice(match[0].length);
}

/**
 * True when the given filename ends in one of the supported skill-module
 * extensions.
 */
function hasCodeExtension(filename: string): boolean {
  for (const ext of SKILL_MODULE_EXTENSIONS) {
    if (filename.endsWith(ext)) {
      return true;
    }
  }
  return false;
}

/**
 * True when the filename appears to be a test or spec file. Test files are
 * excluded from a skill's runtime bundle.
 */
function isTestFile(filename: string): boolean {
  const stem = filename.replace(/\.[^.]+$/, "");
  for (const suffix of TEST_FILE_SUFFIXES) {
    if (stem.endsWith(suffix)) {
      return true;
    }
  }
  return false;
}
