import { createRequire } from "node:module";
import { addSkill } from "./commands/add-skill.js";
import { fatal, info } from "./utils.js";

const require = createRequire(import.meta.url);
const { version } = require("../../package.json");

const HELP_TEXT = `
deepagents v${version}

Usage:
  deepagents <command> [options]

Commands:
  add-skill <name>    Copy a bundled skill module into your project
                      at /skills/<name>/

Options:
  --force             Overwrite existing skill directory without prompting
  --help, -h          Show this help message
  --version, -v       Show version

Examples:
  deepagents add-skill swarm
  deepagents add-skill swarm --force
`.trim();

/**
 * Parsed CLI arguments.
 */
interface ParsedArgs {
  /**
   * The subcommand name (e.g. "add-skill"), or undefined if none provided.
   */
  command: string | undefined;

  /**
   * Positional arguments following the command (e.g. the skill name).
   */
  positional: string[];

  /**
   * Boolean flags parsed from the argument list.
   */
  flags: { force: boolean; help: boolean; version: boolean };
}

/**
 * Parses process.argv into a structured representation.
 */
function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2);
  const flags = { force: false, help: false, version: false };
  const positional: string[] = [];

  for (const arg of args) {
    if (arg === "--force") {
      flags.force = true;
    } else if (arg === "--help" || arg === "-h") {
      flags.help = true;
    } else if (arg === "--version" || arg === "-v") {
      flags.version = true;
    } else if (!arg.startsWith("-")) {
      positional.push(arg);
    }
  }

  return {
    command: positional[0],
    positional: positional.slice(1),
    flags,
  };
}

/**
 * CLI entry point.
 */
async function main(): Promise<void> {
  const parsed = parseArgs(process.argv);
  if (parsed.flags.version) {
    info(version);
    return;
  }

  if (parsed.flags.help || !parsed.command) {
    info(HELP_TEXT);
    return;
  }

  switch (parsed.command) {
    case "add-skill": {
      const skillName = parsed.positional[0];
      if (!skillName) {
        fatal("Missing skill name. Usage: deepagents add-skill <name>");
      }
      await addSkill(skillName, { force: parsed.flags.force });
      break;
    }
    default: {
      fatal(
        `Unknown command "${parsed.command}". Run "deepagents --help" for usage`,
      );
    }
  }
}

main().catch((err) => {
  const message =
    err != null && typeof err === "object" && "message" in err
      ? (err as { message: string }).message
      : String(err);
  fatal(message);
});
