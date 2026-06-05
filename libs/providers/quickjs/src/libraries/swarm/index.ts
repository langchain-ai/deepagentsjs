import * as fs from "node:fs";
import * as path from "node:path";
import * as url from "node:url";
import type { LanguageModelLike } from "@langchain/core/language_models/base";
import {
  isAnthropicModel,
  anthropicPromptCachingMiddleware,
  createPatchToolCallsMiddleware,
  createCacheBreakpointMiddleware,
} from "deepagents";
import type { InterpreterLibrary } from "../../library.js";
import {
  createSwarmTaskTool,
  type SwarmSubAgent,
} from "../../tools/swarm-task.js";
import { stripTypeSyntax } from "../../transform.js";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
// In source: __dirname is src/libraries/swarm/ and assets are adjacent.
// Bundled into dist/index.js: __dirname is dist/ and assets are under libraries/swarm/.
const SWARM_DIR = fs.existsSync(path.join(__dirname, "source"))
  ? __dirname
  : path.join(__dirname, "libraries", "swarm");
const SOURCE_DIR = path.join(SWARM_DIR, "source");
const LIBRARY_MD_PATH = path.join(SWARM_DIR, "LIBRARY.md");

/**
 * Configuration options for the pre-built swarm library.
 */
export interface SwarmOptions {
  /**
   * Subagent specifications for dispatch targets.
   *
   * Each entry becomes a dispatch target selectable via the `subagent_type`
   * parameter in `run()`. These subagents are private to the swarm tool.
   */
  subagents?: SwarmSubAgent[];

  /**
   * Default model for subagent dispatch and invoke mode.
   */
  defaultModel: LanguageModelLike | string;
}

/**
 * Normalize a subagent spec by injecting default middleware.
 *
 * Builds a middleware stack with patch-tool-calls (always) and Anthropic
 * cache controls (when the effective model is Anthropic). Any middleware
 * already on the subagent is appended after the defaults.
 */
function normalizeSubagent(
  sub: SwarmSubAgent,
  defaultModel: LanguageModelLike | string,
): SwarmSubAgent {
  const effectiveModel = sub.model ?? defaultModel;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- middleware types vary across langchain version resolutions in the monorepo
  const middleware: any[] = [createPatchToolCallsMiddleware()];

  if (isAnthropicModel(effectiveModel)) {
    middleware.push(
      anthropicPromptCachingMiddleware({
        unsupportedModelBehavior: "ignore",
        minMessagesToCache: 1,
      }),
      createCacheBreakpointMiddleware(),
    );
  }

  middleware.push(...(sub.middleware ?? []));

  return { ...sub, middleware };
}

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
 * Read the swarm LIBRARY.md documentation from disk.
 */
function loadSwarmDocs(): string {
  return fs.readFileSync(LIBRARY_MD_PATH, "utf-8");
}

/**
 * Create a pre-built swarm interpreter library.
 *
 * Bundles the swarm module source, the `swarm_task` PTC tool, and
 * standard file operation PTC tools into a single `InterpreterLibrary`.
 * Each subagent is normalized with default middleware (patch-tool-calls,
 * Anthropic cache controls when applicable).
 *
 * @example
 * ```typescript
 * import { swarm, createCodeInterpreterMiddleware } from "@langchain/quickjs";
 *
 * const interpreter = createCodeInterpreterMiddleware({
 *   libraries: [
 *     swarm({
 *       subagents: [screener],
 *       defaultModel: "anthropic:claude-sonnet-4-6",
 *     }),
 *   ],
 * });
 * ```
 */
export function swarm(options: SwarmOptions): InterpreterLibrary {
  const normalizedSubagents = (options.subagents ?? []).map((sub) =>
    normalizeSubagent(sub, options.defaultModel),
  );

  const swarmTaskTool = createSwarmTaskTool({
    subagents: normalizedSubagents,
    defaultModel: options.defaultModel,
  });

  const { entrySource, files } = loadSwarmSources();
  const docs = loadSwarmDocs();

  return {
    name: "swarm",
    description:
      "Parallel task processing with handle-based tables (create, run, rows)",
    ptcTools: [swarmTaskTool, "read_file", "write_file", "edit_file", "glob"],
    source: entrySource,
    files,
    docs,
  };
}
