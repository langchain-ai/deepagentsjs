/**
 * Configuration and settings for deepagents.
 *
 * Provides project detection, path management, and environment configuration
 * for skills and agent memory middleware.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

/**
 * Options for creating a Settings instance.
 */
export interface SettingsOptions {
  /** Starting directory for project detection (defaults to cwd) */
  startPath?: string;
}

/**
 * Settings interface for project detection and path management.
 *
 * Provides access to:
 * - Project root detection (via .git directory)
 * - User-level deepagents directory (~/.deepagents)
 * - Agent-specific directories and files
 * - Skills directories (user and project level)
 */
export interface Settings {
  /** Detected project root directory, or null if not in a git project */
  readonly projectRoot: string | null;

  /** Base user-level .deepagents directory (~/.deepagents) */
  readonly userDeepagentsDir: string;

  /** Check if currently in a git project */
  readonly hasProject: boolean;

  /**
   * Get the agent directory path.
   * @param agentName - Name of the agent
   * @returns Path to ~/.deepagents/{agentName}
   * @throws Error if agent name is invalid
   */
  getAgentDir(agentName: string): string;

  /**
   * Ensure agent directory exists and return path.
   * @param agentName - Name of the agent
   * @returns Path to ~/.deepagents/{agentName}
   * @throws Error if agent name is invalid
   */
  ensureAgentDir(agentName: string): string;

  /**
   * Get user-level agent.md path for a specific agent.
   * @param agentName - Name of the agent
   * @returns Path to ~/.deepagents/{agentName}/agent.md
   */
  getUserAgentMdPath(agentName: string): string;

  /**
   * Get project-level agent.md path.
   * @returns Path to {projectRoot}/.deepagents/agent.md, or null if not in a project
   */
  getProjectAgentMdPath(): string | null;

  /**
   * Get user-level skills directory path for a specific agent.
   * @param agentName - Name of the agent
   * @returns Path to ~/.deepagents/{agentName}/skills/
   */
  getUserSkillsDir(agentName: string): string;

  /**
   * Ensure user-level skills directory exists and return path.
   * @param agentName - Name of the agent
   * @returns Path to ~/.deepagents/{agentName}/skills/
   */
  ensureUserSkillsDir(agentName: string): string;

  /**
   * Get project-level skills directory path.
   * @returns Path to {projectRoot}/.deepagents/skills/, or null if not in a project
   */
  getProjectSkillsDir(): string | null;

  /**
   * Ensure project-level skills directory exists and return path.
   * @returns Path to {projectRoot}/.deepagents/skills/, or null if not in a project
   */
  ensureProjectSkillsDir(): string | null;

  /**
   * Ensure project .deepagents directory exists.
   * @returns Path to {projectRoot}/.deepagents/, or null if not in a project
   */
  ensureProjectDeepagentsDir(): string | null;
}

/**
 * Find the project root by looking for .git directory.
 *
 * Walks up the directory tree from startPath (or cwd) looking for a .git
 * directory, which indicates the project root.
 *
 * @param startPath - Directory to start searching from. Defaults to current working directory.
 * @returns Path to the project root if found, null otherwise.
 */
export function findProjectRoot(startPath?: string): string | null {
  let current = path.resolve(startPath || process.cwd());

  // Walk up the directory tree
  while (current !== path.dirname(current)) {
    const gitDir = path.join(current, ".git");
    if (fs.existsSync(gitDir)) {
      return current;
    }
    current = path.dirname(current);
  }

  // Check root directory as well
  const rootGitDir = path.join(current, ".git");
  if (fs.existsSync(rootGitDir)) {
    return current;
  }

  return null;
}

/**
 * Validate agent name to prevent invalid filesystem paths and security issues.
 *
 * @param agentName - The agent name to validate
 * @returns True if valid, false otherwise
 */
function isValidAgentName(agentName: string): boolean {
  if (!agentName || !agentName.trim()) {
    return false;
  }
  // Allow only alphanumeric, hyphens, underscores, and whitespace
  return /^[a-zA-Z0-9_\-\s]+$/.test(agentName);
}

/**
 * Create a Settings instance with detected environment.
 *
 * @param options - Configuration options
 * @returns Settings instance with project detection and path management
 */
export function createSettings(options: SettingsOptions = {}): Settings {
  const projectRoot = findProjectRoot(options.startPath);
  const userDeepagentsDir = path.join(os.homedir(), ".deepagents");

  return {
    projectRoot,
    userDeepagentsDir,
    hasProject: projectRoot !== null,

    getAgentDir(agentName: string): string {
      if (!isValidAgentName(agentName)) {
        throw new Error(
          `Invalid agent name: ${JSON.stringify(agentName)}. ` +
            "Agent names can only contain letters, numbers, hyphens, underscores, and spaces.",
        );
      }
      return path.join(userDeepagentsDir, agentName);
    },

    ensureAgentDir(agentName: string): string {
      const agentDir = this.getAgentDir(agentName);
      fs.mkdirSync(agentDir, { recursive: true });
      return agentDir;
    },

    getUserAgentMdPath(agentName: string): string {
      return path.join(this.getAgentDir(agentName), "agent.md");
    },

    getProjectAgentMdPath(): string | null {
      if (!projectRoot) {
        return null;
      }
      return path.join(projectRoot, ".deepagents", "agent.md");
    },

    getUserSkillsDir(agentName: string): string {
      return path.join(this.getAgentDir(agentName), "skills");
    },

    ensureUserSkillsDir(agentName: string): string {
      const skillsDir = this.getUserSkillsDir(agentName);
      fs.mkdirSync(skillsDir, { recursive: true });
      return skillsDir;
    },

    getProjectSkillsDir(): string | null {
      if (!projectRoot) {
        return null;
      }
      return path.join(projectRoot, ".deepagents", "skills");
    },

    ensureProjectSkillsDir(): string | null {
      const skillsDir = this.getProjectSkillsDir();
      if (!skillsDir) {
        return null;
      }
      fs.mkdirSync(skillsDir, { recursive: true });
      return skillsDir;
    },

    ensureProjectDeepagentsDir(): string | null {
      if (!projectRoot) {
        return null;
      }
      const deepagentsDir = path.join(projectRoot, ".deepagents");
      fs.mkdirSync(deepagentsDir, { recursive: true });
      return deepagentsDir;
    },
  };
}
