#!/usr/bin/env npx tsx
/**
 * Validate a skill directory structure and SKILL.md content.
 *
 * Usage:
 *   npx tsx quick_validate.ts <path/to/skill-folder>
 *
 * Example:
 *   npx tsx quick_validate.ts ~/.deepagents/agent/skills/web-research
 */

import fs from "node:fs";
import path from "node:path";
import yaml from "yaml";

const SKILL_NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const MAX_SKILL_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;
const FRONTMATTER_PATTERN = /^---\s*\n([\s\S]*?)\n---\s*\n/;

const ALLOWED_FRONTMATTER_KEYS = [
  "name",
  "description",
  "license",
  "allowed-tools",
  "metadata",
  "compatibility",
];

interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

function validateSkill(skillDir: string): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Check if directory exists
  if (!fs.existsSync(skillDir)) {
    return {
      valid: false,
      errors: [`Skill directory not found: ${skillDir}`],
      warnings: [],
    };
  }

  // Check for SKILL.md
  const skillMdPath = path.join(skillDir, "SKILL.md");
  if (!fs.existsSync(skillMdPath)) {
    return {
      valid: false,
      errors: ["SKILL.md not found in skill directory"],
      warnings: [],
    };
  }

  // Read and parse SKILL.md
  let content: string;
  try {
    content = fs.readFileSync(skillMdPath, "utf-8");
  } catch (error) {
    return {
      valid: false,
      errors: [`Failed to read SKILL.md: ${error}`],
      warnings: [],
    };
  }

  // Check for frontmatter
  const match = content.match(FRONTMATTER_PATTERN);
  if (!match) {
    errors.push("SKILL.md must start with YAML frontmatter (---\\n...\\n---)");
    return { valid: false, errors, warnings };
  }

  // Parse frontmatter
  let frontmatter: Record<string, unknown>;
  try {
    frontmatter = yaml.parse(match[1]);
  } catch (error) {
    errors.push(`Invalid YAML frontmatter: ${error}`);
    return { valid: false, errors, warnings };
  }

  if (typeof frontmatter !== "object" || frontmatter === null) {
    errors.push("Frontmatter must be a valid YAML object");
    return { valid: false, errors, warnings };
  }

  // Check required fields
  if (!frontmatter.name) {
    errors.push("Missing required field: name");
  }
  if (!frontmatter.description) {
    errors.push("Missing required field: description");
  }

  // Validate name
  if (frontmatter.name) {
    const name = String(frontmatter.name);
    const dirName = path.basename(skillDir);

    if (name.length > MAX_SKILL_NAME_LENGTH) {
      errors.push(`name exceeds ${MAX_SKILL_NAME_LENGTH} characters`);
    }
    if (!SKILL_NAME_PATTERN.test(name)) {
      errors.push(
        "name must be lowercase alphanumeric with hyphens only (e.g., web-research)",
      );
    }
    if (name !== dirName) {
      warnings.push(
        `name '${name}' does not match directory name '${dirName}'`,
      );
    }
  }

  // Validate description
  if (frontmatter.description) {
    const description = String(frontmatter.description);

    if (description.length > MAX_DESCRIPTION_LENGTH) {
      errors.push(`description exceeds ${MAX_DESCRIPTION_LENGTH} characters`);
    }
    if (description.includes("<") || description.includes(">")) {
      warnings.push(
        "description contains angle brackets - ensure this is intentional",
      );
    }
  }

  // Check for unknown frontmatter keys
  for (const key of Object.keys(frontmatter)) {
    if (!ALLOWED_FRONTMATTER_KEYS.includes(key)) {
      warnings.push(`Unknown frontmatter key: ${key}`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    console.log(`
Usage: npx tsx quick_validate.ts <path/to/skill-folder>

Example:
  npx tsx quick_validate.ts ~/.deepagents/agent/skills/web-research
`);
    process.exit(0);
  }

  const skillDir = args[0].replace(/^~/, process.env.HOME || "");
  const result = validateSkill(skillDir);

  if (result.errors.length > 0) {
    console.log("❌ Validation failed:\n");
    for (const error of result.errors) {
      console.log(`  • ${error}`);
    }
  }

  if (result.warnings.length > 0) {
    console.log("\n⚠️  Warnings:\n");
    for (const warning of result.warnings) {
      console.log(`  • ${warning}`);
    }
  }

  if (result.valid) {
    console.log("✓ Skill validation passed!");
  }

  process.exit(result.valid ? 0 : 1);
}

main();
