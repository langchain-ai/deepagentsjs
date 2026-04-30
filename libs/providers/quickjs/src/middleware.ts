/**
 * QuickJS REPL middleware for deepagents.
 *
 * Provides a `js_eval` tool that runs JavaScript in a WASM-sandboxed QuickJS
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
} from "deepagents";
import type { QuickJSMiddlewareOptions } from "./types.js";
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
import { scanSkillReferences } from "./skills.js";

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

const REPL_SYSTEM_PROMPT = dedent`
  ## TypeScript/JavaScript REPL (\`js_eval\`)

  You have access to a sandboxed TypeScript/JavaScript REPL running in an isolated interpreter.
  TypeScript syntax (type annotations, interfaces, generics, \`as\` casts) is supported and stripped at evaluation time.
  Variables, functions, and closures persist across calls within the same session.

  ### Hard rules

  - **No network, no direct filesystem** — only through tools provided in the \`tools\` namespace below.
  - **Cite your sources** — when reporting values from files, include the path and key/index so the user can verify.
  - **Use console.log()** for output — it is captured and returned. \`console.warn()\` and \`console.error()\` are also available.
  - **Reuse state from previous cells** — variables, functions, and results from earlier \`js_eval\` calls persist across calls. Reference them by name in follow-up cells instead of re-embedding data as inline JSON literals.

  ### Limitations

  - ES2023+ syntax with TypeScript support. No Node.js APIs, no \`require\`, no \`import\`.
  - Output is truncated beyond a fixed character limit — be selective about what you log.
  - Execution timeout per call (default 30 s).
`;

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
 * Pull `skillsMetadata` from the task input, resolve the backend, and push
 * both into the session. Short-circuits with a `SkillNotAvailable` error if
 * the source references skills the agent doesn't have.
 */
async function prepareSkillsForEval(
  session: ReplSession,
  skillsBackend: AnyBackendProtocol | BackendFactory,
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

  const resolved = await resolveBackend(skillsBackend, { state: taskInput });
  session.setSkillsContext({ metadata, backend: resolved });
  return undefined;
}

/**
 * Create the QuickJS REPL middleware.
 */
export function createQuickJSMiddleware(
  options: QuickJSMiddlewareOptions = {},
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
  } = options;

  if (maxPtcCalls !== null && maxPtcCalls !== undefined && maxPtcCalls < 1) {
    throw new Error("`maxPtcCalls` must be >= 1 or null");
  }

  const baseSystemPrompt = customSystemPrompt || REPL_SYSTEM_PROMPT;

  const middlewareId = crypto.randomUUID();

  let cachedPtcPrompt: string | null = null;

  let ptcTools: StructuredToolInterface[] = [];

  function filterToolsForPtc(
    allTools: StructuredToolInterface[],
  ): StructuredToolInterface[] {
    if (!ptc) return [];

    const candidates = allTools.filter((t) => t.name !== "js_eval");

    return resolveToolList(ptc, candidates);
  }

  const jsEvalTool = tool(
    async (input, config: LangGraphRunnableConfig) => {
      const threadId = config.configurable?.thread_id || DEFAULT_SESSION_ID;
      const sessionKey = `${threadId}:${middlewareId}`;

      const session = ReplSession.getOrCreate(sessionKey, {
        memoryLimitBytes,
        maxStackSizeBytes,
        maxPtcCalls,
        tools: ptcTools,
        skillsEnabled: skillsBackend !== undefined,
        maxResultChars,
      });

      if (skillsBackend !== undefined) {
        const setupError = await prepareSkillsForEval(
          session,
          skillsBackend,
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
      name: "js_eval",
      description: dedent`
        Evaluate TypeScript/JavaScript code in a sandboxed REPL. State persists across calls.
        Use console.log() for output. Returns the result of the last expression.
        If file or other tools are available, call them via the tools namespace: await tools.readFile({ path }).
        If skills are configured, dynamically import them: await import("@/skills/<name>").
      `,
      schema: z.object({
        code: z
          .string()
          .describe(
            "TypeScript/JavaScript code to evaluate in the sandboxed REPL",
          ),
      }),
    },
  );

  return createMiddleware({
    name: "QuickJSMiddleware",
    tools: [jsEvalTool],
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
}
