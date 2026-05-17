/**
 * Wasmsh Python REPL middleware for deepagents.
 *
 * Exposes a `py_eval` tool that runs Python inside a wasmsh sandbox (Pyodide
 * in WebAssembly). State (variables, imports, defined functions) persists
 * across calls within the same session via the sandbox's globals pickle.
 *
 * Mirrors the shape of `langchain-quickjs`'s `CodeInterpreterMiddleware` but
 * with a real host-memory-isolated sandbox. Supports:
 *
 * - Persistent state across evaluations (true REPL)
 * - Programmatic tool calling (PTC) via the host_call/host_call_result wire
 *   protocol
 * - Python skills loading (`import skills.<name>`) via a paired
 *   `SkillsMiddleware` and shared `BackendProtocol`
 */
import {
  createMiddleware,
  tool,
  type AgentMiddleware as _AgentMiddleware,
} from "langchain";
import { z } from "zod/v4";
import type { StructuredToolInterface } from "@langchain/core/tools";
import {
  resolveBackend,
  type BackendProtocolV2,
  type BackendRuntime,
} from "deepagents";
import dedent from "dedent";

/**
 * Type-only imports kept in step with `quickjs/middleware.ts` so the
 * langchain/langgraph middleware system resolves its generic parameters
 * correctly at module load.
 */
import type * as _zodTypes from "@langchain/core/utils/types";
import type * as _zodMeta from "@langchain/langgraph/zod";
import type * as _messages from "@langchain/core/messages";
import {
  getCurrentTaskInput,
  type LangGraphRunnableConfig,
} from "@langchain/langgraph";

import { WasmshSandbox } from "./sandbox.js";
import {
  type WasmshLogger,
  type WasmshMiddlewareOptions,
  type ReplEnvelope,
} from "./types.js";
import {
  formatEnvelope,
  isValidPythonIdentifier,
  toSnakeCase,
} from "./utils.js";
import { installPendingSkills, type SkillMetadata } from "./skills.js";

/** Default tool name; matches the Python adapter. */
const DEFAULT_TOOL_NAME = "py_eval";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RESULT_CHARS = 4_000;

/**
 * Backend-provided tools excluded from PTC by default. These overlap with
 * the in-sandbox filesystem/shell access user code already has.
 */
export const DEFAULT_PTC_EXCLUDED_TOOLS = [
  "ls",
  "read_file",
  "write_file",
  "edit_file",
  "glob",
  "grep",
  "execute",
] as const;

const REPL_SYSTEM_PROMPT = dedent`
  ## Python REPL (\`py_eval\`)

  You have access to a sandboxed Python REPL running inside a wasmsh
  WebAssembly sandbox (Pyodide). Variables, imports, and defined
  functions persist across calls within the same session.

  ### Hard rules

  - **Sandbox boundary** — there is a full /workspace virtual filesystem
    and the wasmsh shell utilities (\`subprocess.run\`); outbound network
    calls are blocked unless explicitly allowlisted by the host.
  - **Use \`print(...)\`** for intermediate output; the trailing
    expression of the block is returned automatically when it is not
    \`None\`.
  - **Top-level \`await\`** is supported — write \`await some_coroutine()\`
    directly.
  - **Reuse state from previous cells** — variables, functions, and
    results from earlier \`py_eval\` calls persist across calls. Reference
    them by name in follow-up cells instead of re-embedding data as
    inline literals.

  ### Example

  \`\`\`python
  import json
  data = json.loads(open("/workspace/config.json").read())
  data["threshold"]
  \`\`\`
`;

/** Render the PTC API-reference section appended to the system prompt. */
function generatePtcPrompt(tools: StructuredToolInterface[]): string {
  if (tools.length === 0) return "";
  const lines = tools.map((t) => {
    const desc = (t.description || "").trim().split("\n")[0];
    const snake = toSnakeCase(t.name);
    return `    async def ${snake}(**kwargs) -> str: """${desc}"""`;
  });
  return dedent`

    ### API Reference — \`tools\` namespace

    The following agent tools are callable as async methods on the global
    \`tools\` object. Each takes keyword arguments and returns the tool's
    native value (passed through unchanged for primitives; complex types
    become repr strings). Use \`await\` for each call; combine with
    \`asyncio.gather(...)\` for parallel fan-out.

    \`\`\`python
    class tools:
    ${lines.join("\n")}
    \`\`\`
  `;
}

function filterToolsForPtc(
  allTools: StructuredToolInterface[],
  selfToolName: string,
  ptc: WasmshMiddlewareOptions["ptc"],
): StructuredToolInterface[] {
  if (ptc === undefined || ptc === false) return [];
  const candidates = allTools.filter((t) => t.name !== selfToolName);
  if (ptc === true) {
    const excluded = new Set<string>(DEFAULT_PTC_EXCLUDED_TOOLS);
    return candidates.filter((t) => !excluded.has(t.name));
  }
  if (Array.isArray(ptc)) {
    const included = new Set(ptc);
    return candidates.filter((t) => included.has(t.name));
  }
  if ("include" in ptc) {
    const included = new Set(ptc.include);
    return candidates.filter((t) => included.has(t.name));
  }
  if ("exclude" in ptc) {
    const excluded = new Set([...DEFAULT_PTC_EXCLUDED_TOOLS, ...ptc.exclude]);
    return candidates.filter((t) => !excluded.has(t.name));
  }
  return [];
}

function ensurePythonIdentifier(tool: StructuredToolInterface): void {
  const snake = toSnakeCase(tool.name);
  if (!isValidPythonIdentifier(snake)) {
    throw new Error(
      `PTC tool name ${JSON.stringify(tool.name)} cannot be exposed as ` +
        `Python identifier ${JSON.stringify(snake)}`,
    );
  }
}

async function dispatchHostCall(
  call: { id: string; tool: string; args: Record<string, unknown> },
  toolsByPyName: Map<string, StructuredToolInterface>,
  logger?: WasmshLogger,
): Promise<{ ok: boolean; value?: unknown; error?: string; message?: string }> {
  const tool = toolsByPyName.get(call.tool);
  if (!tool) {
    return {
      ok: false,
      error: "UnknownToolError",
      message: `tool ${JSON.stringify(call.tool)} is not on the PTC allowlist`,
    };
  }
  try {
    const raw = await tool.invoke(call.args ?? {});
    return { ok: true, value: raw };
  } catch (err) {
    // The error must round-trip into the sandbox as a structured envelope —
    // the model needs to see it to recover — but the stack and call context
    // get lost in that conversion. The logger hook gives the host a single
    // place to record the full original error for observability.
    try {
      logger?.ptcToolError?.({
        tool: call.tool,
        callId: call.id,
        args: call.args ?? {},
        error: err,
      });
    } catch {
      // Logger contract forbids throwing; if it does anyway, swallow so the
      // envelope still reaches the model.
    }
    const error = err as { name?: string; message?: string } | undefined;
    return {
      ok: false,
      error: error?.name ?? "Error",
      message: error?.message ?? String(err),
    };
  }
}

/**
 * Build the Wasmsh Python REPL middleware.
 */
export function createWasmshInterpreterMiddleware(
  options: WasmshMiddlewareOptions = {},
) {
  const toolName = options.toolName ?? DEFAULT_TOOL_NAME;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxResultChars = options.maxResultChars ?? DEFAULT_MAX_RESULT_CHARS;
  const baseSystemPrompt =
    options.systemPrompt === undefined
      ? REPL_SYSTEM_PROMPT
      : options.systemPrompt;
  const sandboxFactory =
    options.sandboxFactory ?? (() => WasmshSandbox.createNode());

  // Lazily-created sandbox shared across calls. The first eval boots it
  // (~1s) and subsequent calls reuse it for state persistence.
  let sandboxPromise: Promise<WasmshSandbox> | null = null;
  const getSandbox = () => {
    if (!sandboxPromise) sandboxPromise = sandboxFactory();
    return sandboxPromise;
  };

  // Skills cache, populated lazily on first matching `import skills.<name>`.
  const installedSkills = new Set<string>();

  // Per-turn PTC tool list, refreshed by `wrapModelCall` before each model
  // call so the eval tool sees the live agent toolset.
  let activePtcTools: StructuredToolInterface[] = [];
  let cachedPtcPrompt: string | null = null;

  const pyEvalTool = tool(
    async (input, config: LangGraphRunnableConfig): Promise<string> => {
      const sandbox = await getSandbox();

      // Stage any newly-referenced skills before the eval runs.
      if (options.skillsBackend !== undefined) {
        const runtime: BackendRuntime = {
          ...config,
          state: getCurrentTaskInput(config) || {},
        } as BackendRuntime;
        const backend = await resolveBackend(options.skillsBackend, runtime);
        const metadata = collectSkillsMetadata(runtime);
        if (metadata.size > 0) {
          const backendV2 = backend as unknown as BackendProtocolV2;
          if (typeof backendV2.downloadFiles !== "function") {
            throw new Error(
              "skills_backend must implement downloadFiles (V2 surface)",
            );
          }
          await installPendingSkills({
            source: input.code,
            metadata,
            backend: backendV2 as {
              glob: BackendProtocolV2["glob"];
              downloadFiles: NonNullable<BackendProtocolV2["downloadFiles"]>;
            },
            sandbox,
            installed: installedSkills,
            logger: options.logger,
          });
        }
      }

      // Resolve the snake-case → tool map once per eval.
      const toolsByPyName = new Map<string, StructuredToolInterface>();
      for (const t of activePtcTools) {
        toolsByPyName.set(toSnakeCase(t.name), t);
      }

      const envelope: ReplEnvelope = await sandbox.runPtc({
        code: input.code,
        tools: [...toolsByPyName.keys()],
        onHostCall: (call) =>
          dispatchHostCall(call, toolsByPyName, options.logger),
      });
      return formatEnvelope(envelope, maxResultChars);
    },
    {
      name: toolName,
      description: dedent`
        Execute Python in a persistent wasmsh sandbox REPL. Variables,
        imports, and defined functions persist across calls. A virtual
        filesystem is available; shell utilities are reachable via
        subprocess. The sandbox is WebAssembly-isolated; outbound network
        calls are blocked unless explicitly allowlisted.
      `,
      schema: z.object({
        code: z
          .string()
          .describe(
            "Python source to evaluate in the persistent wasmsh REPL. " +
              "Top-level await is supported.",
          ),
      }),
    },
  );

  return createMiddleware({
    name: "WasmshInterpreterMiddleware",
    tools: [pyEvalTool],
    wrapModelCall: async (request, handler) => {
      const agentTools = (request.tools || []) as StructuredToolInterface[];
      const exposed = filterToolsForPtc(agentTools, toolName, options.ptc);
      exposed.forEach(ensurePythonIdentifier);
      activePtcTools = exposed;

      if (exposed.length > 0 && cachedPtcPrompt === null) {
        cachedPtcPrompt = generatePtcPrompt(exposed);
      }
      const promptSuffix = exposed.length > 0 ? (cachedPtcPrompt ?? "") : "";
      const systemMessage = baseSystemPrompt
        ? request.systemMessage.concat(baseSystemPrompt).concat(promptSuffix)
        : request.systemMessage.concat(promptSuffix);
      // `timeoutMs` is accepted as an option for API parity with the Python
      // adapter but is not yet wired into the prompt or sandbox budget; see
      // the open TODO on the constructor docstring.
      void timeoutMs;
      return handler({ ...request, systemMessage });
    },
    // No `afterAgent` cleanup: the lazily-booted sandbox is meant to span
    // multiple `agent.invoke()` calls so REPL state persists across turns.
    // Sandbox lifetime is bound to the middleware instance; rely on GC + the
    // sandbox's own close-on-process-exit handlers for teardown.
  });
}

function collectSkillsMetadata(
  runtime: BackendRuntime,
): Map<string, SkillMetadata> {
  const state = (runtime as { state?: unknown }).state;
  const list =
    state && typeof state === "object" && "skills_metadata" in state
      ? ((state as { skills_metadata?: SkillMetadata[] }).skills_metadata ?? [])
      : [];
  const out = new Map<string, SkillMetadata>();
  for (const meta of list) out.set(meta.name, meta);
  return out;
}
