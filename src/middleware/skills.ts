/**
 * Middleware for loading and exposing agent skills to the system prompt.
 *
 * This middleware implements Anthropic's "Agent Skills" pattern with progressive disclosure:
 * 1. Parse YAML frontmatter from SKILL.md files at session start
 * 2. Inject skills metadata (name + description) into system prompt
 * 3. Agent reads full SKILL.md content when relevant to a task
 *
 * Skills directory structure (per-agent + project):
 * User-level: ~/.deepagents/{AGENT_NAME}/skills/
 * Project-level: {PROJECT_ROOT}/.deepagents/skills/
 *
 * @example
 * ```
 * ~/.deepagents/{AGENT_NAME}/skills/
 * ├── web-research/
 * │   ├── SKILL.md        # Required: YAML frontmatter + instructions
 * │   └── helper.py       # Optional: supporting files
 * ├── code-review/
 * │   ├── SKILL.md
 * │   └── checklist.md
 *
 * .deepagents/skills/
 * ├── project-specific/
 * │   └── SKILL.md        # Project-specific skills
 * ```
 */

import { z } from "zod";
import type { AgentMiddleware } from "langchain/agents/middleware/types";
import { listSkills, type SkillMetadata } from "../skills/loader.js";

/**
 * Options for the skills middleware.
 */
export interface SkillsMiddlewareOptions {
  /** Path to the user-level skills directory (per-agent) */
  skillsDir: string;

  /** The agent identifier for path references in prompts */
  assistantId: string;

  /** Optional path to project-level skills directory */
  projectSkillsDir?: string;
}

/**
 * State schema for skills middleware.
 */
const SkillsStateSchema = z.object({
  skillsMetadata: z
    .array(
      z.object({
        name: z.string(),
        description: z.string(),
        path: z.string(),
        source: z.enum(["user", "project"]),
        license: z.string().optional(),
        compatibility: z.string().optional(),
        metadata: z.record(z.string()).optional(),
        allowedTools: z.string().optional(),
      }),
    )
    .optional(),
});

/**
 * Skills System Documentation prompt template.
 */
const SKILLS_SYSTEM_PROMPT = `

## Skills System

You have access to a skills library that provides specialized capabilities and domain knowledge.

{skills_locations}

**Available Skills:**

{skills_list}

**How to Use Skills (Progressive Disclosure):**

Skills follow a **progressive disclosure** pattern - you know they exist (name + description above), but you only read the full instructions when needed:

1. **Recognize when a skill applies**: Check if the user's task matches any skill's description
2. **Read the skill's full instructions**: The skill list above shows the exact path to use with read_file
3. **Follow the skill's instructions**: SKILL.md contains step-by-step workflows, best practices, and examples
4. **Access supporting files**: Skills may include Python scripts, configs, or reference docs - use absolute paths

**When to Use Skills:**
- When the user's request matches a skill's domain (e.g., "research X" → web-research skill)
- When you need specialized knowledge or structured workflows
- When a skill provides proven patterns for complex tasks

**Skills are Self-Documenting:**
- Each SKILL.md tells you exactly what the skill does and how to use it
- The skill list above shows the full path for each skill's SKILL.md file

**Executing Skill Scripts:**
Skills may contain Python scripts or other executable files. Always use absolute paths from the skill list.

**Example Workflow:**

User: "Can you research the latest developments in quantum computing?"

1. Check available skills above → See "web-research" skill with its full path
2. Read the skill using the path shown in the list
3. Follow the skill's research workflow (search → organize → synthesize)
4. Use any helper scripts with absolute paths

Remember: Skills are tools to make you more capable and consistent. When in doubt, check if a skill exists for the task!
`;

/**
 * Format skills locations for display in system prompt.
 */
function formatSkillsLocations(
  userSkillsDisplay: string,
  projectSkillsDir?: string,
): string {
  const locations = [`**User Skills**: \`${userSkillsDisplay}\``];
  if (projectSkillsDir) {
    locations.push(
      `**Project Skills**: \`${projectSkillsDir}\` (overrides user skills)`,
    );
  }
  return locations.join("\n");
}

/**
 * Format skills metadata for display in system prompt.
 */
function formatSkillsList(
  skills: SkillMetadata[],
  userSkillsDisplay: string,
  projectSkillsDir?: string,
): string {
  if (skills.length === 0) {
    const locations = [userSkillsDisplay];
    if (projectSkillsDir) {
      locations.push(projectSkillsDir);
    }
    return `(No skills available yet. You can create skills in ${locations.join(" or ")})`;
  }

  // Group skills by source
  const userSkills = skills.filter((s) => s.source === "user");
  const projectSkills = skills.filter((s) => s.source === "project");

  const lines: string[] = [];

  // Show user skills
  if (userSkills.length > 0) {
    lines.push("**User Skills:**");
    for (const skill of userSkills) {
      lines.push(`- **${skill.name}**: ${skill.description}`);
      lines.push(`  → Read \`${skill.path}\` for full instructions`);
    }
    lines.push("");
  }

  // Show project skills
  if (projectSkills.length > 0) {
    lines.push("**Project Skills:**");
    for (const skill of projectSkills) {
      lines.push(`- **${skill.name}**: ${skill.description}`);
      lines.push(`  → Read \`${skill.path}\` for full instructions`);
    }
  }

  return lines.join("\n");
}

/**
 * Create middleware for loading and exposing agent skills.
 *
 * This middleware implements Anthropic's agent skills pattern:
 * - Loads skills metadata (name, description) from YAML frontmatter at session start
 * - Injects skills list into system prompt for discoverability
 * - Agent reads full SKILL.md content when a skill is relevant (progressive disclosure)
 *
 * Supports both user-level and project-level skills:
 * - User skills: ~/.deepagents/{AGENT_NAME}/skills/
 * - Project skills: {PROJECT_ROOT}/.deepagents/skills/
 * - Project skills override user skills with the same name
 *
 * @param options - Configuration options
 * @returns AgentMiddleware for skills loading and injection
 */
export function createSkillsMiddleware(
  options: SkillsMiddlewareOptions,
): AgentMiddleware {
  const { skillsDir, assistantId, projectSkillsDir } = options;

  // Store display paths for prompts
  const userSkillsDisplay = `~/.deepagents/${assistantId}/skills`;

  return {
    name: "SkillsMiddleware",
    stateSchema: SkillsStateSchema as any,

    beforeAgent(state: any) {
      // We re-load skills on every new interaction with the agent to capture
      // any changes in the skills directories.
      const skills = listSkills({
        userSkillsDir: skillsDir,
        projectSkillsDir: projectSkillsDir,
      });
      return { skillsMetadata: skills };
    },

    wrapModelCall(request: any, handler: any) {
      // Get skills metadata from state
      const skillsMetadata: SkillMetadata[] =
        request.state?.skillsMetadata || [];

      // Format skills locations and list
      const skillsLocations = formatSkillsLocations(
        userSkillsDisplay,
        projectSkillsDir,
      );
      const skillsList = formatSkillsList(
        skillsMetadata,
        userSkillsDisplay,
        projectSkillsDir,
      );

      // Format the skills documentation
      const skillsSection = SKILLS_SYSTEM_PROMPT.replace(
        "{skills_locations}",
        skillsLocations,
      ).replace("{skills_list}", skillsList);

      // Append to existing system prompt
      const currentSystemPrompt = request.systemPrompt || "";
      const newSystemPrompt = currentSystemPrompt
        ? `${currentSystemPrompt}\n\n${skillsSection}`
        : skillsSection;

      return handler({ ...request, systemPrompt: newSystemPrompt });
    },
  };
}

