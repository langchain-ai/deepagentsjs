import * as fs from "node:fs/promises";
import * as path from "node:path";
import { resolveSkillsRoot } from "./shared.js";
import { confirm, fatal, info, success, warn } from "../utils.js";

/** File suffixes to exclude when copying skill module sources. */
const EXCLUDED_SUFFIXES = [".test.ts", ".test.js", ".spec.ts", ".spec.js"];

/**
 * Resolves the path to bundled skill module sources shipped with the package.
 */
export function resolveSkillSourceDir(skillName: string): string {
  return path.join(resolveSkillsRoot(), skillName);
}

/**
 * Returns true if the given path exists on the filesystem.
 */
async function exists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Collects all non-test files from the source directory (non-recursive).
 * Returns a sorted array of filenames.
 */
export async function collectSkillFiles(sourceDir: string): Promise<string[]> {
  const entries = await fs.readdir(sourceDir);
  return entries
    .filter(
      (entry) => !EXCLUDED_SUFFIXES.some((suffix) => entry.endsWith(suffix)),
    )
    .sort();
}

/**
 * Copies a single file from source to destination, creating parent
 * directories as needed.
 */
async function copyFile(src: string, dest: string): Promise<void> {
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.copyFile(src, dest);
}

/**
 * Executes the `add-skill` command.
 *
 * Copies a bundled skill module into the user's project at `/skills/<name>/`.
 * If the destination directory already exists, prompts the user for
 * confirmation before overwriting. The `--force` flag skips the prompt.
 */
export async function addSkill(
  skillName: string,
  options: { force?: boolean; sourceDir?: string },
): Promise<void> {
  const sourceDir = options.sourceDir ?? resolveSkillSourceDir(skillName);
  if (!(await exists(sourceDir))) {
    fatal(`Unknown skill module "${skillName}"`);
  }

  const destDir = path.resolve(process.cwd(), "skills", skillName);

  if (await exists(destDir)) {
    if (!options.force) {
      warn(`Skill module "${skillName}" already exists at ${destDir}`);
      const shouldOverwrite = await confirm("Overwrite existing files?");
      if (!shouldOverwrite) {
        info("Aborted");
        return;
      }
    }
  }

  const files = await collectSkillFiles(sourceDir);
  if (files.length === 0) {
    fatal(`No skill module files found in ${sourceDir}`);
  }

  for (const file of files) {
    await copyFile(path.join(sourceDir, file), path.join(destDir, file));
  }

  success(`Added skill module "${skillName}" to /skills/${skillName}/`);
  info("Files copied:");
  for (const file of files) {
    info(`  skills/${skillName}/${file}`);
  }
}
