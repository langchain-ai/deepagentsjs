import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import { resolveSkillsRoot } from "./shared.js";
import { fatal, info } from "../utils.js";

/**
 * Parsed SKILL.md frontmatter.
 */
interface SkillInfo {
  name: string;
  description: string;
}

/**
 * Reads and parses YAML frontmatter from a SKILL.md file.
 * Returns null if the file is missing or has no valid frontmatter.
 */
async function parseSkillFrontmatter(
  skillMdPath: string,
): Promise<SkillInfo | null> {
  let content: string;
  try {
    content = await fs.readFile(skillMdPath, "utf-8");
  } catch {
    return null;
  }

  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) {
    return null;
  }

  try {
    const frontmatter = parseYaml(match[1]) as Record<string, unknown>;
    if (
      typeof frontmatter.name === "string" &&
      typeof frontmatter.description === "string"
    ) {
      return {
        name: frontmatter.name,
        description: frontmatter.description,
      };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Executes the `list-skills` command.
 *
 * Scans the bundled `src/skills/` directory for subdirectories containing
 * a SKILL.md with valid frontmatter and prints each skill's name and
 * description.
 */
export async function listSkills(options?: {
  skillsRoot?: string;
}): Promise<void> {
  const skillsRoot = options?.skillsRoot ?? resolveSkillsRoot();

  let entries: string[];
  try {
    entries = await fs.readdir(skillsRoot);
  } catch {
    fatal("Could not read bundled skills directory");
  }

  const skills: SkillInfo[] = [];
  for (const entry of entries) {
    const entryPath = path.join(skillsRoot, entry);
    const stat = await fs.stat(entryPath);
    if (!stat.isDirectory()) {
      continue;
    }

    const skillInfo = await parseSkillFrontmatter(
      path.join(entryPath, "SKILL.md"),
    );
    if (skillInfo) {
      skills.push(skillInfo);
    }
  }

  if (skills.length === 0) {
    info("No skill modules found.");
    return;
  }

  info("Available skill modules:\n");
  for (const skill of skills.sort((a, b) => a.name.localeCompare(b.name))) {
    info(`  ${skill.name}`);
    info(`    ${skill.description}\n`);
  }

  info("Add a skill to your project with: deepagents add-skill <name>");
}
