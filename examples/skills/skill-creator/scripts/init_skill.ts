#!/usr/bin/env npx tsx
/**
 * Initialize a new skill directory with template files.
 *
 * Usage:
 *   npx tsx init_skill.ts <skill-name> --path <output-directory>
 *
 * Example:
 *   npx tsx init_skill.ts web-research --path ~/.deepagents/agent/skills
 */

import fs from "node:fs";
import path from "node:path";

const SKILL_NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const MAX_SKILL_NAME_LENGTH = 64;

function validateSkillName(name: string): { valid: boolean; error?: string } {
  if (!name) {
    return { valid: false, error: "Skill name is required" };
  }
  if (name.length > MAX_SKILL_NAME_LENGTH) {
    return {
      valid: false,
      error: `Skill name exceeds ${MAX_SKILL_NAME_LENGTH} characters`,
    };
  }
  if (!SKILL_NAME_PATTERN.test(name)) {
    return {
      valid: false,
      error:
        "Skill name must be lowercase alphanumeric with hyphens only (e.g., web-research)",
    };
  }
  return { valid: true };
}

function createSkillTemplate(skillName: string): string {
  const titleName = skillName
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");

  return `---
name: ${skillName}
description: Brief description of what this skill does and when to use it.
---

# ${titleName}

## Description

[Provide a detailed explanation of what this skill does and when it should be used]

## When to Use

- [Scenario 1: When the user asks...]
- [Scenario 2: When you need to...]
- [Scenario 3: When the task involves...]

## How to Use

### Step 1: [First Action]
[Explain what to do first]

### Step 2: [Second Action]
[Explain what to do next]

### Step 3: [Final Action]
[Explain how to complete the task]

## Best Practices

- [Best practice 1]
- [Best practice 2]
- [Best practice 3]

## Supporting Files

This skill directory can include supporting files referenced in the instructions:
- \`scripts/\` - TypeScript/JavaScript scripts for automation
- \`references/\` - Additional reference documentation
- \`assets/\` - Templates, images, or other assets

## Examples

### Example 1: [Scenario Name]

**User Request:** "[Example user request]"

**Approach:**
1. [Step-by-step breakdown]
2. [Using tools and commands]
3. [Expected outcome]
`;
}

function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    console.log(`
Usage: npx tsx init_skill.ts <skill-name> --path <output-directory>

Arguments:
  skill-name          Name of the skill (lowercase, hyphens allowed)
  --path <dir>        Directory where the skill folder will be created

Example:
  npx tsx init_skill.ts web-research --path ~/.deepagents/agent/skills
`);
    process.exit(0);
  }

  const skillName = args[0];
  const pathIndex = args.indexOf("--path");

  if (pathIndex === -1 || !args[pathIndex + 1]) {
    console.error("Error: --path argument is required");
    process.exit(1);
  }

  const outputDir = args[pathIndex + 1].replace(/^~/, process.env.HOME || "");

  // Validate skill name
  const validation = validateSkillName(skillName);
  if (!validation.valid) {
    console.error(`Error: ${validation.error}`);
    process.exit(1);
  }

  // Create skill directory
  const skillDir = path.join(outputDir, skillName);

  if (fs.existsSync(skillDir)) {
    console.error(`Error: Skill directory already exists: ${skillDir}`);
    process.exit(1);
  }

  // Create directories
  fs.mkdirSync(skillDir, { recursive: true });
  fs.mkdirSync(path.join(skillDir, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(skillDir, "references"), { recursive: true });
  fs.mkdirSync(path.join(skillDir, "assets"), { recursive: true });

  // Create SKILL.md
  const skillMd = createSkillTemplate(skillName);
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), skillMd);

  // Create placeholder files
  fs.writeFileSync(
    path.join(skillDir, "scripts", ".gitkeep"),
    "# Add your scripts here\n",
  );
  fs.writeFileSync(
    path.join(skillDir, "references", ".gitkeep"),
    "# Add your reference documentation here\n",
  );
  fs.writeFileSync(
    path.join(skillDir, "assets", ".gitkeep"),
    "# Add your assets here\n",
  );

  console.log(`✓ Skill '${skillName}' created successfully!`);
  console.log(`  Location: ${skillDir}`);
  console.log(`
Next steps:
  1. Edit ${path.join(skillDir, "SKILL.md")} to customize the skill
  2. Add any supporting scripts, references, or assets
  3. Run quick_validate.ts to verify the skill structure
`);
}

main();
