import * as fs from "node:fs";
import * as path from "node:path";
import * as url from "node:url";
import type { SubagentPoolRef } from "deepagents";
import type { InterpreterLibrary } from "../../library.js";
import { createSwarmTaskTool } from "../../tools/swarm-task.js";
import { stripTypeSyntax } from "../../transform.js";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
// In source: __dirname is src/libraries/swarm/ and assets are adjacent.
// Bundled into dist/index.js: __dirname is dist/ and assets are under libraries/swarm/.
const SWARM_DIR = fs.existsSync(path.join(__dirname, "source"))
  ? __dirname
  : path.join(__dirname, "libraries", "swarm");
const SOURCE_DIR = path.join(SWARM_DIR, "source");
const INSTRUCTIONS_PATH = path.join(SWARM_DIR, "INSTRUCTIONS.md");

/**
 * Read and strip all swarm module source files from disk.
 *
 * Returns the entrypoint source and a map of relative filename to
 * stripped JS source. Called once per `swarm()` invocation.
 */
function loadSwarmSources(): {
  entrySource: string;
  files: Map<string, string>;
} {
  const files = new Map<string, string>();
  let entrySource = "";

  const entries = fs.readdirSync(SOURCE_DIR);
  for (const filename of entries) {
    if (!filename.endsWith(".ts") && !filename.endsWith(".js")) continue;
    if (filename.endsWith(".d.ts")) continue;

    const fullPath = path.join(SOURCE_DIR, filename);
    const raw = fs.readFileSync(fullPath, "utf-8");
    const stripped = stripTypeSyntax(raw);

    if (filename === "index.ts" || filename === "index.js") {
      entrySource = stripped;
    } else {
      files.set(filename, stripped);
    }
  }

  if (!entrySource) {
    throw new Error("Swarm library: missing index.ts entrypoint in source/");
  }

  return { entrySource, files };
}

/**
 * Read the swarm LIBRARY.md instructions from disk.
 */
function loadSwarmInstructions(): string {
  return fs.readFileSync(INSTRUCTIONS_PATH, "utf-8");
}

/**
 * Create a pre-built swarm interpreter library.
 *
 * Subagent specs are not configured here — they are automatically
 * inherited from the main agent's subagent pool via `createDeepAgent`.
 * The swarm library creates an internal {@link SubagentPoolRef} that
 * `createDeepAgent` discovers and populates during agent construction.
 *
 * @example
 * ```typescript
 * import { swarm, createCodeInterpreterMiddleware } from "@langchain/quickjs";
 * import { createDeepAgent } from "deepagents";
 *
 * const interpreter = createCodeInterpreterMiddleware({
 *   libraries: [swarm()],
 * });
 *
 * const agent = createDeepAgent({
 *   model,
 *   subagents: [
 *     { name: "reviewer", description: "Reviews code", systemPrompt: "..." },
 *   ],
 *   middleware: [interpreter],
 * });
 * ```
 */
export function swarm(): InterpreterLibrary {
  const subagentPool: SubagentPoolRef = { current: null };

  const swarmTaskTool = createSwarmTaskTool({ subagentPool });

  const { entrySource, files } = loadSwarmSources();
  const instructions = loadSwarmInstructions();

  return {
    name: "swarm",
    description:
      "Parallel task processing with handle-based tables (create, run, reduce, rows)",
    ptcTools: [swarmTaskTool, "read_file", "write_file", "edit_file", "glob"],
    source: entrySource,
    files,
    instructions,
    subagentPool,
  };
}
