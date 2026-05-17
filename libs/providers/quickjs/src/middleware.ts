/**
 * Code Interpreter middleware for deepagents.
 *
 * Provides an `eval` tool that runs JavaScript in a WASM-sandboxed QuickJS
 * interpreter. Supports:
 * - Persistent state across evaluations (true REPL)
 * - Programmatic tool calling (PTC) — expose agent or custom tools inside the REPL
 */

import {
  createMiddleware,
  tool,
  type AgentMiddleware as _AgentMiddleware,
} from "langchain";
import { z } from "zod/v4";
import type { StructuredToolInterface } from "@langchain/core/tools";

import dedent from "dedent";
import { getCurrentTaskInput } from "@langchain/langgraph";
import {
  resolveBackend,
  type AnyBackendProtocol,
  type BackendFactory,
  type SkillMetadata,
  type SkillRegistry,
} from "deepagents";
import type { CodeInterpreterMiddlewareOptions, SkillLoader } from "./types.js";
import {
  ReplSession,
  DEFAULT_EXECUTION_TIMEOUT,
  DEFAULT_MEMORY_LIMIT,
  DEFAULT_MAX_STACK_SIZE,
  DEFAULT_SESSION_ID,
  DEFAULT_MAX_PTC_CALLS,
  DEFAULT_MAX_RESULTS_CHARS,
} from "./session.js";
import {
  formatReplResult,
  formatSkillNotAvailable,
  toCamelCase,
  toolToTypeSignature,
  safeToJsonSchema,
} from "./utils.js";
import { loadSkill, scanSkillReferences } from "./skills.js";
import { stripTypeSyntax } from "./transform.js";

/**
 * These type-only imports are required for TypeScript's type inference to work
 * correctly with the langchain/langgraph middleware system. Without them, certain
 * generic type parameters fail to resolve properly, causing runtime issues with
 * tool schemas and message types.
 */
import type * as _zodTypes from "@langchain/core/utils/types";
import type * as _zodMeta from "@langchain/langgraph/zod";
import type * as _messages from "@langchain/core/messages";
import { LangGraphRunnableConfig } from "@langchain/langgraph";

/**
 * Cross-package symbol `createDeepAgent` looks up on each user-provided
 * middleware to forward the agent's `SkillRegistry` into the code
 * interpreter without the user having to configure skills twice.
 *
 * The value is a registry-shared symbol (`Symbol.for(...)`) so the same
 * key is reachable from `deepagents` and `@langchain/quickjs` regardless
 * of how either package is bundled or duplicated on disk.
 *
 * @internal Not part of the public SDK contract. Only `createDeepAgent`
 *   should ever read or call this.
 */
export const SKILL_REGISTRY_INJECT_SYMBOL = Symbol.for(
  "@langchain/quickjs.code-interpreter.injectSkillRegistry",
);

const DEFAULT_TOOL_NAME = "eval";

function renderReplSystemPrompt(opts: {
  toolName: string;
  timeout: number;
  memoryLimitMb: number;
}): string {
  return dedent`
    ### Interpreter

    An \`${opts.toolName}\` tool is available. It runs JavaScript in a persistent REPL.
    - State (variables, functions) persists across tool calls within a single turn of conversation. They DO NOT persist across multiple turns.
    - Top-level \`await\` works; Promises resolve before the call returns.
    - Sandboxed: no filesystem, no stdlib, no network, no real clock, no \`fetch\`, no \`require\`.
    - Timeout: ${opts.timeout}s per call. Memory: ${opts.memoryLimitMb} MB total.
    - \`console.log\` output is captured and returned alongside the result.
  `;
}

/**
 * Generate the PTC API Reference section for the system prompt.
 */
export async function generatePtcPrompt(
  tools: StructuredToolInterface[],
): Promise<string> {
  if (tools.length === 0) return "";

  const signatures = await Promise.all(
    tools.map((t) => {
      const jsonSchema = t.schema ? safeToJsonSchema(t.schema) : undefined;
      return toolToTypeSignature(
        toCamelCase(t.name),
        t.description,
        jsonSchema,
      );
    }),
  );

  return dedent`

    ### API Reference — \`tools\` namespace

    The following agent tools are callable as async functions inside the REPL.
    Each takes a single object argument and returns a Promise that resolves to a string.
    Use \`await\` to call them. Promise APIs like \`Promise.all\` are also available.

    **Example usage:**
    \`\`\`javascript
    // Call a tool
    const result = await tools.searchWeb({ query: "QuickJS tutorial" });
    console.log(result);

    // Concurrent calls
    const [a, b] = await Promise.all([
      tools.fetchData({ url: "https://api.example.com/a" }),
      tools.fetchData({ url: "https://api.example.com/b" }),
    ]);
    \`\`\`

    **Available functions:**
    \`\`\`typescript
    ${signatures.join("\n\n")}
    \`\`\`
  `;
}

/**
 * Resolves a mixed list of tool names and tool instances into a flat list of
 * StructuredToolInterface objects. Strings are looked up by name in agentTools;
 * instances are included directly without requiring agent registration. Strings
 * that don't match any agent tool are silently omitted.
 */
export function resolveToolList(
  items: (string | StructuredToolInterface)[],
  agentTools: StructuredToolInterface[],
): StructuredToolInterface[] {
  const agentByName = new Map(agentTools.map((t) => [t.name, t]));
  return items.flatMap((item) => {
    if (typeof item === "string") {
      const found = agentByName.get(item);
      return found ? [found] : [];
    }
    return [item];
  });
}

/**
 * Build a `SkillLoader` backed by the shared registry. The underlying
 * `provider.load(name)` runs at most once per agent invocation since
 * both the `skill` tool and this loader share the registry's cache.
 */
function buildRegistryLoader(registry: SkillRegistry): SkillLoader {
  return async (name, metadata) => {
    const loaded = await registry.load(name);
    return assembleEntry(loaded.files, metadata);
  };
}

/**
 * Build a `SkillLoader` backed by the deprecated `skillsBackend`. Kept
 * working for callers that still configure the code interpreter
 * directly with a backend.
 */
function buildBackendLoader(
  backend: AnyBackendProtocol | BackendFactory,
): SkillLoader {
  return async (_name, metadata) => {
    const taskInput = getCurrentTaskInput();
    const resolved = await resolveBackend(backend, { state: taskInput });
    const loaded = await loadSkill(metadata, resolved);
    return { files: loaded.files, entryRel: loaded.entryRel };
  };
}

/**
 * Convert a provider's raw source map into the QuickJS-shape entry the
 * session expects (TS-stripped source, entrypoint identified).
 */
function assembleEntry(
  rawFiles: Map<string, string>,
  metadata: SkillMetadata,
): { files: Map<string, string>; entryRel: string } {
  const entryRel = resolveEntryRel(metadata);

  const files = new Map<string, string>();
  let entryPresent = false;
  for (const [rel, source] of rawFiles) {
    files.set(rel, stripTypeSyntax(source));
    if (rel === entryRel) {
      entryPresent = true;
    }
  }
  if (!entryPresent) {
    throw new Error(
      `Skill '${metadata.name}': entrypoint '${entryRel}' did not match any file in the loaded bundle`,
    );
  }
  return { files, entryRel };
}

/**
 * Resolve the entrypoint path for a skill from its metadata. Prefers the
 * spec-friendly `metadata.entrypoint` key; falls back to the legacy
 * `module:` field for pre-spec skills.
 */
function resolveEntryRel(metadata: SkillMetadata): string {
  const fromExtension = metadata.metadata?.entrypoint;
  if (typeof fromExtension === "string" && fromExtension.length > 0) {
    return normalizeRel(fromExtension);
  }
  if (typeof metadata.module === "string" && metadata.module.length > 0) {
    return normalizeRel(metadata.module);
  }
  throw new Error(
    `Skill '${metadata.name}' has no entrypoint (set \`metadata.entrypoint\` in SKILL.md)`,
  );
}

/**
 * Strip a leading `./` from a skill-relative path so the value matches
 * the keys used inside the QuickJS session's in-memory module cache.
 */
function normalizeRel(p: string): string {
  if (p.startsWith("./")) {
    return p.slice(2);
  }
  return p;
}

/**
 * Pull `skillsMetadata` from the task input and push it into the session
 * paired with the per-eval skill loader. Short-circuits with a
 * `SkillNotAvailable` error if the source references skills the agent
 * doesn't have.
 */
async function prepareSkillsForEval(
  session: ReplSession,
  loader: SkillLoader,
  code: string,
): Promise<string | undefined> {
  const taskInput = getCurrentTaskInput<{ skillsMetadata?: SkillMetadata[] }>();
  const metadata: SkillMetadata[] = taskInput?.skillsMetadata ?? [];

  const referenced = scanSkillReferences(code);
  if (referenced.size > 0) {
    const known = new Set(metadata.map((m) => m.name));
    const missing: string[] = [];
    for (const name of referenced) {
      if (!known.has(name)) {
        missing.push(name);
      }
    }
    if (missing.length > 0) {
      session.setSkillsContext(undefined);
      return formatSkillNotAvailable(missing);
    }
  }

  session.setSkillsContext({ metadata, load: loader });
  return undefined;
}

/**
 * Create the Code Interpreter middleware.
 */
export function createCodeInterpreterMiddleware(
  options: CodeInterpreterMiddlewareOptions = {},
) {
  const {
    ptc,
    memoryLimitBytes = DEFAULT_MEMORY_LIMIT,
    maxStackSizeBytes = DEFAULT_MAX_STACK_SIZE,
    executionTimeoutMs = DEFAULT_EXECUTION_TIMEOUT,
    systemPrompt: customSystemPrompt = null,
    skillsBackend,
    maxPtcCalls = DEFAULT_MAX_PTC_CALLS,
    maxResultChars = DEFAULT_MAX_RESULTS_CHARS,
    toolName = DEFAULT_TOOL_NAME,
    captureConsole = true,
  } = options;

  if (maxPtcCalls !== null && maxPtcCalls !== undefined && maxPtcCalls < 1) {
    throw new Error("`maxPtcCalls` must be >= 1 or null");
  }

  // `SkillRegistry` arrives after the middleware is constructed when
  // `createDeepAgent` calls the symbol setter installed below. Until that
  // fires, only the deprecated `skillsBackend` path is available.
  let injectedRegistry: SkillRegistry | undefined;
  let cachedLoader: SkillLoader | undefined;

  const skillsEnabled = (): boolean =>
    injectedRegistry !== undefined || skillsBackend !== undefined;

  const getSkillLoader = (): SkillLoader | undefined => {
    if (cachedLoader !== undefined) {
      return cachedLoader;
    }
    if (injectedRegistry !== undefined) {
      cachedLoader = buildRegistryLoader(injectedRegistry);
      return cachedLoader;
    }
    if (skillsBackend !== undefined) {
      cachedLoader = buildBackendLoader(skillsBackend);
      return cachedLoader;
    }
    return undefined;
  };

  const baseSystemPrompt =
    customSystemPrompt ||
    renderReplSystemPrompt({
      toolName,
      timeout: executionTimeoutMs / 1000,
      memoryLimitMb: Math.floor(memoryLimitBytes / (1024 * 1024)),
    });

  const middlewareId = crypto.randomUUID();

  let cachedPtcPrompt: string | null = null;

  let ptcTools: StructuredToolInterface[] = [];

  function filterToolsForPtc(
    allTools: StructuredToolInterface[],
  ): StructuredToolInterface[] {
    if (!ptc) return [];

    const candidates = allTools.filter((t) => t.name !== toolName);

    return resolveToolList(ptc, candidates);
  }

  const evalTool = tool(
    async (input, config: LangGraphRunnableConfig) => {
      const threadId = config.configurable?.thread_id || DEFAULT_SESSION_ID;
      const sessionKey = `${threadId}:${middlewareId}`;

      const session = ReplSession.getOrCreate(sessionKey, {
        memoryLimitBytes,
        maxStackSizeBytes,
        maxPtcCalls,
        tools: ptcTools,
        skillsEnabled: skillsEnabled(),
        maxResultChars,
        captureConsole,
      });

      const loader = getSkillLoader();
      if (loader !== undefined) {
        const setupError = await prepareSkillsForEval(
          session,
          loader,
          input.code,
        );
        if (setupError !== undefined) {
          return setupError;
        }
      }

      const result = await session.eval(input.code, executionTimeoutMs);
      return formatReplResult(result);
    },
    {
      name: toolName,
      description: dedent`
        Evaluate TypeScript/JavaScript code in a sandboxed REPL. State persists across calls.
        Use console.log() for output. Returns the result of the last expression.
        If file or other tools are available, call them via the tools namespace: await tools.readFile({ path }).
        If skills are configured, dynamically import them: await import("@/skills/<name>").
      `,
      metadata: { ls_code_input_language: "javascript" },
      schema: z.object({
        code: z
          .string()
          .describe(
            "TypeScript/JavaScript code to evaluate in the sandboxed REPL",
          ),
      }),
    },
  );

  const middleware = createMiddleware({
    name: "CodeInterpreterMiddleware",
    tools: [evalTool],
    wrapModelCall: async (request, handler) => {
      const agentTools = (request.tools || []) as StructuredToolInterface[];
      ptcTools = filterToolsForPtc(agentTools);

      if (ptcTools.length > 0 && !cachedPtcPrompt) {
        cachedPtcPrompt = await generatePtcPrompt(ptcTools);
      }

      const systemMessage = request.systemMessage
        .concat(baseSystemPrompt)
        .concat(cachedPtcPrompt || "");
      return handler({ ...request, systemMessage });
    },
    afterAgent: async (_state, runtime) => {
      const threadId = runtime.configurable?.thread_id ?? DEFAULT_SESSION_ID;
      const sessionKey = `${threadId}:${middlewareId}`;
      ReplSession.deleteSession(sessionKey);
    },
  });

  /**
   * Setter installed for `createDeepAgent` to forward the agent's
   * `SkillRegistry` into this middleware. Hidden behind `Symbol.for(...)`
   * so it doesn't show up on user-facing surfaces but stays reachable
   * across package boundaries. Idempotent; latest call wins.
   */
  Object.defineProperty(middleware, SKILL_REGISTRY_INJECT_SYMBOL, {
    value: (registry: SkillRegistry | null | undefined): void => {
      if (registry === null || registry === undefined) {
        return;
      }
      injectedRegistry = registry;
      cachedLoader = undefined;
    },
    enumerable: false,
    writable: false,
    configurable: false,
  });

  return middleware;
}
