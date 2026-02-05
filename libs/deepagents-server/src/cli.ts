/**
 * DeepAgents ACP Server CLI
 *
 * Run a DeepAgents ACP server for integration with IDEs like Zed.
 *
 * Usage:
 *   npx deepagents-server [options]
 *
 * Options:
 *   --name <name>         Agent name (default: "deepagents")
 *   --description <desc>  Agent description
 *   --model <model>       LLM model (default: "claude-sonnet-4-5-20250929")
 *   --workspace <path>    Workspace root directory (default: cwd)
 *   --skills <paths>      Comma-separated skill paths
 *   --memory <paths>      Comma-separated memory/AGENTS.md paths
 *   --debug               Enable debug logging
 *   --help                Show this help message
 *   --version             Show version
 */

import { DeepAgentsServer } from "./server.js";
import { FilesystemBackend } from "deepagents";
import * as path from "node:path";
import * as fs from "node:fs";

interface CLIOptions {
  name: string;
  description: string;
  model: string;
  workspace: string;
  skills: string[];
  memory: string[];
  debug: boolean;
  help: boolean;
  version: boolean;
}

function parseArgs(args: string[]): CLIOptions {
  const options: CLIOptions = {
    name: "deepagents",
    description: "AI coding assistant powered by DeepAgents",
    model: "claude-sonnet-4-5-20250929",
    workspace: process.cwd(),
    skills: [],
    memory: [],
    debug: process.env.DEBUG === "true",
    help: false,
    version: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const nextArg = args[i + 1];

    switch (arg) {
      case "--name":
      case "-n":
        if (nextArg) {
          options.name = nextArg;
          i++;
        }
        break;

      case "--description":
      case "-d":
        if (nextArg) {
          options.description = nextArg;
          i++;
        }
        break;

      case "--model":
      case "-m":
        if (nextArg) {
          options.model = nextArg;
          i++;
        }
        break;

      case "--workspace":
      case "-w":
        if (nextArg) {
          options.workspace = path.resolve(nextArg);
          i++;
        }
        break;

      case "--skills":
      case "-s":
        if (nextArg) {
          options.skills = nextArg.split(",").map((p) => p.trim());
          i++;
        }
        break;

      case "--memory":
        if (nextArg) {
          options.memory = nextArg.split(",").map((p) => p.trim());
          i++;
        }
        break;

      case "--debug":
        options.debug = true;
        break;

      case "--help":
      case "-h":
        options.help = true;
        break;

      case "--version":
      case "-v":
        options.version = true;
        break;
    }
  }

  return options;
}

function showHelp(): void {
  console.log(`
DeepAgents ACP Server

Run a DeepAgents-powered AI coding assistant that integrates with IDEs
like Zed, JetBrains, and other ACP-compatible clients.

USAGE:
  npx deepagents-server [options]

OPTIONS:
  -n, --name <name>         Agent name (default: "deepagents")
  -d, --description <desc>  Agent description
  -m, --model <model>       LLM model (default: "claude-sonnet-4-5-20250929")
  -w, --workspace <path>    Workspace root directory (default: current directory)
  -s, --skills <paths>      Comma-separated skill paths (SKILL.md locations)
      --memory <paths>      Comma-separated memory paths (AGENTS.md locations)
      --debug               Enable debug logging to stderr
  -h, --help                Show this help message
  -v, --version             Show version

ENVIRONMENT VARIABLES:
  ANTHROPIC_API_KEY         API key for Anthropic models (required for Claude)
  OPENAI_API_KEY            API key for OpenAI models
  DEBUG                     Set to "true" to enable debug logging
  WORKSPACE_ROOT            Alternative to --workspace flag

EXAMPLES:
  # Start with defaults
  npx deepagents-server

  # Custom agent with skills
  npx deepagents-server --name my-agent --skills ./skills,~/.deepagents/skills

  # Debug mode with custom workspace
  npx deepagents-server --debug --workspace /path/to/project

ZED INTEGRATION:
  Add to your Zed settings.json:

  {
    "agent": {
      "profiles": {
        "deepagents": {
          "name": "DeepAgents",
          "command": "npx",
          "args": ["deepagents-server"],
          "env": {}
        }
      }
    }
  }

For more information, visit:
  https://github.com/langchain-ai/deepagentsjs
`);
}

function showVersion(): void {
  // Read version from package.json
  try {
    const packageJsonPath = path.resolve(
      import.meta.dirname ?? __dirname,
      "..",
      "package.json",
    );
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));
    console.log(`deepagents-server v${packageJson.version}`);
  } catch {
    console.log("deepagents-server v0.0.1");
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const options = parseArgs(args);

  if (options.help) {
    showHelp();
    process.exit(0);
  }

  if (options.version) {
    showVersion();
    process.exit(0);
  }

  // Use environment variable as fallback for workspace
  const workspaceRoot =
    options.workspace || process.env.WORKSPACE_ROOT || process.cwd();

  // Build default skill/memory paths if not provided
  const defaultSkillPaths = [
    path.join(workspaceRoot, ".deepagents", "skills"),
    path.join(workspaceRoot, "skills"),
  ];

  const defaultMemoryPaths = [
    path.join(workspaceRoot, ".deepagents", "AGENTS.md"),
    path.join(workspaceRoot, "AGENTS.md"),
  ];

  const skills =
    options.skills.length > 0
      ? options.skills.map((p) => path.resolve(workspaceRoot, p))
      : defaultSkillPaths;

  const memory =
    options.memory.length > 0
      ? options.memory.map((p) => path.resolve(workspaceRoot, p))
      : defaultMemoryPaths;

  // Log startup info to stderr (stdout is reserved for ACP protocol)
  const log = (...msgArgs: unknown[]) => {
    if (options.debug) {
      console.error("[deepagents-server]", ...msgArgs);
    }
  };

  log("Starting...");
  log("Agent:", options.name);
  log("Model:", options.model);
  log("Workspace:", workspaceRoot);
  log("Skills:", skills.join(", "));
  log("Memory:", memory.join(", "));

  try {
    const server = new DeepAgentsServer({
      agents: {
        name: options.name,
        description: options.description,
        model: options.model,
        backend: new FilesystemBackend({ rootDir: workspaceRoot }),
        skills,
        memory,
      },
      serverName: "deepagents-server",
      workspaceRoot,
      debug: options.debug,
    });

    await server.start();
  } catch (error) {
    console.error("[deepagents-server] Fatal error:", error);
    process.exit(1);
  }
}

// Handle top-level errors
main().catch((err) => {
  console.error("[deepagents-server] Unhandled error:", err);
  process.exit(1);
});
