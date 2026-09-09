/**
 * Middleware for loading agent-specific long-term memory into the system prompt.
 *
 * This middleware loads the agent's long-term memory from agent.md files
 * and injects it into the system prompt. Memory is loaded from:
 * - User memory: ~/.deepagents/{agent_name}/agent.md
 * - Project memory: {project_root}/.deepagents/agent.md
 *
 * @deprecated Use `createMemoryMiddleware` from `./memory.js` instead.
 * This middleware uses direct filesystem access (Node.js fs module) which is not
 * portable across backends. The `createMemoryMiddleware` function uses the
 * `BackendProtocol` abstraction and follows the AGENTS.md specification.
 *
 * Migration example:
 * ```typescript
 * // Before (deprecated):
 * import { createAgentMemoryMiddleware } from "./agent-memory.js";
 * const middleware = createAgentMemoryMiddleware({ settings, assistantId });
 *
 * // After (recommended):
 * import { createMemoryMiddleware } from "./memory.js";
 * import { FilesystemBackend } from "../backends/filesystem.js";
 *
 * const middleware = createMemoryMiddleware({
 *   backend: new FilesystemBackend({ rootDir: "/" }),
 *   sources: [
 *     `~/.deepagents/${assistantId}/AGENTS.md`,
 *     `${projectRoot}/.deepagents/AGENTS.md`,
 *   ],
 * });
 * ```
 */

import fs from "node:fs";
import { z } from "zod";
import {
  createMiddleware,
  /**
   * required for type inference
   */
  type AgentMiddleware as _AgentMiddleware,
} from "langchain";

import type { Settings } from "../config.js";

/**
 * Options for the agent memory middleware.
 */
export interface AgentMemoryMiddlewareOptions {
  /** Settings instance with project detection and paths */
  settings: Settings;

  /** The agent identifier */
  assistantId: string;

  /** Optional custom template for injecting agent memory into system prompt */
  systemPromptTemplate?: string;
}

/**
 * State schema for agent memory middleware.
 */
const AgentMemoryStateSchema = z.object({
  /** Personal preferences from ~/.deepagents/{agent}/ (applies everywhere) */
  userMemory: z.string().optional(),

  /** Project-specific context (loaded from project root) */
  projectMemory: z.string().optional(),
});

/**
 * Default template for memory injection.
 */
const DEFAULT_MEMORY_TEMPLATE = `<user_memory>
{user_memory}
</user_memory>

<project_memory>
{project_memory}
</project_memory>`;

/**
 * Long-term Memory Documentation system prompt.
 */
const LONGTERM_MEMORY_SYSTEM_PROMPT = `

## Long-term Memory

Your long-term memory is stored in files on the filesystem and persists across sessions.

**User Memory Location**: \`{agent_dir_absolute}\` (displays as \`{agent_dir_display}\`)
**Project Memory Location**: {project_memory_info}

Your system prompt is loaded from TWO sources at startup:
1. **User agent.md**: \`{agent_dir_absolute}/agent.md\` - Your personal preferences across all projects
2. **Project agent.md**: Loaded from project root if available - Project-specific instructions

Project-specific agent.md is loaded from these locations (both combined if both exist):
- \`[project-root]/.deepagents/agent.md\` (preferred)
- \`[project-root]/agent.md\` (fallback, but also included if both exist)

**When to CHECK/READ memories (CRITICAL - do this FIRST):**
- **At the start of ANY new session**: Check both user and project memories
  - User: \`ls {agent_dir_absolute}\`
  - Project: \`ls {project_deepagents_dir}\` (if in a project)
- **BEFORE answering questions**: If asked "what do you know about X?" or "how do I do Y?", check project memories FIRST, then user
- **When user asks you to do something**: Check if you have project-specific guides or examples
- **When user references past work**: Search project memory files for related context

**Memory-first response pattern:**
1. User asks a question → Check project directory first: \`ls {project_deepagents_dir}\`
2. If relevant files exist → Read them with \`read_file '{project_deepagents_dir}/[filename]'\`
3. Check user memory if needed → \`ls {agent_dir_absolute}\`
4. Base your answer on saved knowledge supplemented by general knowledge

**When to update memories:**
- **IMMEDIATELY when the user describes your role or how you should behave**
- **IMMEDIATELY when the user gives feedback on your work** - Update memories to capture what was wrong and how to do it better
- When the user explicitly asks you to remember something
- When patterns or preferences emerge (coding styles, conventions, workflows)
- After significant work where context would help in future sessions

**Learning from feedback:**
- When user says something is better/worse, capture WHY and encode it as a pattern
- Each correction is a chance to improve permanently - don't just fix the immediate issue, update your instructions
- When user says "you should remember X" or "be careful about Y", treat this as HIGH PRIORITY - update memories IMMEDIATELY
- Look for the underlying principle behind corrections, not just the specific mistake

## Deciding Where to Store Memory

When writing or updating agent memory, decide whether each fact, configuration, or behavior belongs in:

### User Agent File: \`{agent_dir_absolute}/agent.md\`
→ Describes the agent's **personality, style, and universal behavior** across all projects.

**Store here:**
- Your general tone and communication style
- Universal coding preferences (formatting, comment style, etc.)
- General workflows and methodologies you follow
- Tool usage patterns that apply everywhere
- Personal preferences that don't change per-project

**Examples:**
- "Be concise and direct in responses"
- "Always use type hints in Python"
- "Prefer functional programming patterns"

### Project Agent File: \`{project_deepagents_dir}/agent.md\`
→ Describes **how this specific project works** and **how the agent should behave here only.**

**Store here:**
- Project-specific architecture and design patterns
- Coding conventions specific to this codebase
- Project structure and organization
- Testing strategies for this project
- Deployment processes and workflows
- Team conventions and guidelines

**Examples:**
- "This project uses FastAPI with SQLAlchemy"
- "Tests go in tests/ directory mirroring src/ structure"
- "All API changes require updating OpenAPI spec"

### Project Memory Files: \`{project_deepagents_dir}/*.md\`
→ Use for **project-specific reference information** and structured notes.

**Store here:**
- API design documentation
- Architecture decisions and rationale
- Deployment procedures
- Common debugging patterns
- Onboarding information

**Examples:**
- \`{project_deepagents_dir}/api-design.md\` - REST API patterns used
- \`{project_deepagents_dir}/architecture.md\` - System architecture overview
- \`{project_deepagents_dir}/deployment.md\` - How to deploy this project

### File Operations:

**User memory:**
\`\`\`
ls {agent_dir_absolute}                              # List user memory files
read_file '{agent_dir_absolute}/agent.md'            # Read user preferences
edit_file '{agent_dir_absolute}/agent.md' ...        # Update user preferences
\`\`\`

**Project memory (preferred for project-specific information):**
\`\`\`
ls {project_deepagents_dir}                          # List project memory files
read_file '{project_deepagents_dir}/agent.md'        # Read project instructions
edit_file '{project_deepagents_dir}/agent.md' ...    # Update project instructions
write_file '{project_deepagents_dir}/agent.md' ...  # Create project memory file
\`\`\`

**Important**:
- Project memory files are stored in \`.deepagents/\` inside the project root
- Always use absolute paths for file operations
- Check project memories BEFORE user when answering project-specific questions`;

/**
 * Create middleware for loading agent-specific long-term memory.
 *
 * This middleware loads the agent's long-term memory from a file (agent.md)
 * and injects it into the system prompt. The memory is loaded once at the
 * start of the conversation and stored in state.
 *
 * @param options - Configuration options
 * @returns AgentMiddleware for memory loading and injection
 *
 * @deprecated Use `createMemoryMiddleware` from `./memory.js` instead.
 * This function uses direct filesystem access which limits portability.
 */
export function createAgentMemoryMiddleware(
  options: AgentMemoryMiddlewareOptions,
) {
  const { settings, assistantId, systemPromptTemplate } = options;

  // Compute paths
  const agentDir = settings.getAgentDir(assistantId);
  const agentDirDisplay = `~/.deepagents/${assistantId}`;
  const agentDirAbsolute = agentDir;
  const projectRoot = settings.projectRoot;

  // Build project memory info for documentation
  const projectMemoryInfo = projectRoot
    ? `\`${projectRoot}\` (detected)`
    : "None (not in a git project)";

  // Build project deepagents directory path
  const projectDeepagentsDir = projectRoot
    ? `${projectRoot}/.deepagents`
    : "[project-root]/.deepagents (not in a project)";

  const template = systemPromptTemplate || DEFAULT_MEMORY_TEMPLATE;

  return createMiddleware({
    name: "AgentMemoryMiddleware",
    stateSchema: AgentMemoryStateSchema as any,

    beforeAgent(state: any) {
      const result: Record<string, string> = {};

      // Load user memory if not already in state
      if (!("userMemory" in state)) {
        const userPath = settings.getUserAgentMdPath(assistantId);
        if (fs.existsSync(userPath)) {
          try {
            result.userMemory = fs.readFileSync(userPath, "utf-8");
          } catch {
            // Ignore read errors
          }
        }
      }

      // Load project memory if not already in state
      if (!("projectMemory" in state)) {
        const projectPath = settings.getProjectAgentMdPath();
        if (projectPath && fs.existsSync(projectPath)) {
          try {
            result.projectMemory = fs.readFileSync(projectPath, "utf-8");
          } catch {
            // Ignore read errors
          }
        }
      }

      return Object.keys(result).length > 0 ? result : undefined;
    },

    wrapModelCall(request: any, handler: any) {
      // Extract memory from state
      const userMemory = request.state?.userMemory;
      const projectMemory = request.state?.projectMemory;
      const baseSystemPrompt = request.systemPrompt || "";

      // Format memory section with both memories
      const memorySection = template
        .replace("{user_memory}", userMemory || "(No user agent.md)")
        .replace("{project_memory}", projectMemory || "(No project agent.md)");

      // Format long-term memory documentation
      const memoryDocs = LONGTERM_MEMORY_SYSTEM_PROMPT.replaceAll(
        "{agent_dir_absolute}",
        agentDirAbsolute,
      )
        .replaceAll("{agent_dir_display}", agentDirDisplay)
        .replaceAll("{project_memory_info}", projectMemoryInfo)
        .replaceAll("{project_deepagents_dir}", projectDeepagentsDir);

      // Memory content at start, base prompt in middle, documentation at end
      let systemPrompt = memorySection;
      if (baseSystemPrompt) {
        systemPrompt += "\n\n" + baseSystemPrompt;
      }
      systemPrompt += "\n\n" + memoryDocs;

      return handler({ ...request, systemPrompt });
    },
  });
}
