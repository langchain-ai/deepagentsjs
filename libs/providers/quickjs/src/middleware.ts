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
} from "deepagents";
import type {
  CodeInterpreterMiddlewareOptions,
  LibraryEntry,
} from "./types.js";
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
import type { InterpreterLibrary } from "./library.js";
import type { SubagentPoolRef } from "deepagents";

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
    - Runtime sandbox: no built-in filesystem, network, stdlib, or wall-clock APIs (\`fetch\`, \`require\`, \`fs\`, \`process\`, real \`Date.now()\` are unavailable or stubbed). External side effects from inside the REPL are only reachable via the \`tools.*\` namespace when it is exposed (see below); without it, the REPL is pure computation.
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
 * Pull `skillsMetadata` from the task input, resolve the backend, and push
 * both into the session. Short-circuits with a `SkillNotAvailable` error if
 * the source references skills the agent doesn't have.
 */
async function prepareSkillsForEval(
  session: ReplSession,
  skillsBackend: AnyBackendProtocol | BackendFactory,
  code: string,
  ptcTools: StructuredToolInterface[],
): Promise<string | undefined> {
  const taskInput = getCurrentTaskInput<{ skillsMetadata?: SkillMetadata[] }>();
  const metadata: SkillMetadata[] = taskInput?.skillsMetadata ?? [];

  const referenced = scanSkillReferences(code);
  if (referenced.size > 0) {
    const known = new Map(metadata.map((m) => [m.name, m]));
    const missing: string[] = [];
    const ptcToolNames = new Set(ptcTools.map((t) => t.name));

    for (const name of referenced) {
      const skill = known.get(name);
      if (!skill) {
        missing.push(name);
        continue;
      }

      const rawPtc = skill.metadata?.["required-ptc-tools"] ?? "";
      const requiredPtc = rawPtc
        ? String(rawPtc).split(/\s+/).filter(Boolean)
        : [];
      const missingPtc = requiredPtc.filter((t) => !ptcToolNames.has(t));

      if (missingPtc.length > 0) {
        session.setSkillsContext(undefined);
        return (
          `Skill '${name}' requires PTC tools that are not configured: ` +
          `${missingPtc.join(", ")}. ` +
          `Add them to createQuickJSMiddleware({ ptc: [...] }).`
        );
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
 * Create the Code Interpreter middleware.
 */
export function createCodeInterpreterMiddleware(
  options: CodeInterpreterMiddlewareOptions = {},
) {
  const {
    memoryLimitBytes = DEFAULT_MEMORY_LIMIT,
    maxStackSizeBytes = DEFAULT_MAX_STACK_SIZE,
    executionTimeoutMs = DEFAULT_EXECUTION_TIMEOUT,
    systemPrompt: customSystemPrompt = null,
    skillsBackend,
    maxPtcCalls = DEFAULT_MAX_PTC_CALLS,
    maxResultChars = DEFAULT_MAX_RESULTS_CHARS,
    toolName = DEFAULT_TOOL_NAME,
    captureConsole = true,
    enableWorkflows = false,
  } = options;

  if (maxPtcCalls !== null && maxPtcCalls !== undefined && maxPtcCalls < 1) {
    throw new Error("`maxPtcCalls` must be >= 1 or null");
  }

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

  const libraries = options.libraries ?? [];
  const aggregatedPtc = aggregatePtcTools(options.ptc, libraries);

  /**
   * Libraries registered at construction time plus any promoted from
   * workflow drafts via `save_workflow`. The session and prompt are
   * rebuilt each turn from this list so new libraries are picked up.
   */
  const allLibraries: InterpreterLibrary[] = [...libraries];

  function filterToolsForPtc(
    allTools: StructuredToolInterface[],
  ): StructuredToolInterface[] {
    if (aggregatedPtc.length === 0) return [];

    const candidates = allTools.filter((t) => t.name !== toolName);

    return resolveToolList(aggregatedPtc, candidates);
  }

  function aggregatePtcTools(
    explicitPtc: (string | StructuredToolInterface)[] | undefined,
    libs: InterpreterLibrary[],
  ): (string | StructuredToolInterface)[] {
    const seen = new Set<string>();
    const result: (string | StructuredToolInterface)[] = [];

    // Explicit ptc first — user declarations take precedence
    for (const item of explicitPtc ?? []) {
      const name = typeof item === "string" ? item : item.name;
      if (!seen.has(name)) {
        seen.add(name);
        result.push(item);
      }
    }

    // Library tool declarations — only add if not already explicit
    for (const lib of libs) {
      for (const item of lib.ptcTools) {
        const name = typeof item === "string" ? item : item.name;
        if (!seen.has(name)) {
          seen.add(name);
          result.push(item);
        }
      }
    }

    return result;
  }

  function renderLibrariesPrompt(libs: InterpreterLibrary[]): string {
    if (libs.length === 0) return "";

    const entries = libs
      .map(
        (lib) =>
          `- **${lib.name}**: ${lib.description}\n` +
          `  → \`import { ... } from "${lib.name}"\``,
      )
      .join("\n");

    const instructionBlocks = libs
      .filter((lib) => lib.instructions)
      .map(
        (lib) =>
          `<library name="${lib.name}">\n${lib.instructions}\n</library>`,
      )
      .join("\n\n");

    return dedent`

      ### Interpreter Libraries

      The following libraries are pre-loaded in the code interpreter and available via \`import\`:

      ${entries}

      ${instructionBlocks}
    `;
  }

  // Libraries prompt is rebuilt each turn to pick up saved workflows.
  let librariesPrompt = renderLibrariesPrompt(allLibraries);

  const evalTool = tool(
    async (input, config: LangGraphRunnableConfig) => {
      const threadId = config.configurable?.thread_id || DEFAULT_SESSION_ID;
      const sessionKey = `${threadId}:${middlewareId}`;

      const session = ReplSession.getOrCreate(sessionKey, {
        memoryLimitBytes,
        maxStackSizeBytes,
        maxPtcCalls,
        tools: ptcTools,
        skillsEnabled: skillsBackend !== undefined,
        libraries: libraries.map(
          (lib): LibraryEntry => ({
            name: lib.name,
            source: lib.source,
            files: lib.files,
          }),
        ),
        maxResultChars,
        captureConsole,
        sessionId: threadId,
      });

      if (skillsBackend !== undefined) {
        const setupError = await prepareSkillsForEval(
          session,
          skillsBackend,
          input.code,
          ptcTools,
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

  // --------------- Workflow tools (POC) ---------------

  interface WorkflowEntry {
    name: string;
    description: string;
    code: string;
  }

  const workflowDrafts = new Map<string, WorkflowEntry>();

  /**
   * Get or create the shared ReplSession for a given config.
   */
  function getSession(config: LangGraphRunnableConfig): ReplSession {
    const threadId = config.configurable?.thread_id || DEFAULT_SESSION_ID;
    const sessionKey = `${threadId}:${middlewareId}`;
    return ReplSession.getOrCreate(sessionKey, {
      memoryLimitBytes,
      maxStackSizeBytes,
      maxPtcCalls,
      tools: ptcTools,
      skillsEnabled: skillsBackend !== undefined,
      libraries: allLibraries.map(
        (lib): LibraryEntry => ({
          name: lib.name,
          source: lib.source,
          files: lib.files,
        }),
      ),
      maxResultChars,
      captureConsole,
      sessionId: threadId,
    });
  }

  const runWorkflowTool = tool(
    async (input, config: LangGraphRunnableConfig) => {
      const session = getSession(config);

      if (skillsBackend !== undefined) {
        const setupError = await prepareSkillsForEval(
          session,
          skillsBackend,
          input.code,
          ptcTools,
        );
        if (setupError !== undefined) {
          return setupError;
        }
      }

      // Strip `export` keywords for eval (only valid in module context).
      // The original code with exports is preserved for the saved library.
      const evalCode = input.code.replace(/\bexport\s+(default\s+)?/g, "");
      const result = await session.eval(evalCode, executionTimeoutMs);

      workflowDrafts.set(input.name, {
        name: input.name,
        description: input.description,
        code: input.code,
      });

      const resultText = formatReplResult(result);
      return `Workflow "${input.name}" executed and saved as draft.\n\n${resultText}`;
    },
    {
      name: "run_workflow",
      description: dedent`
        Execute a workflow pipeline in the code interpreter and save it as a reusable draft.
        Use this instead of eval when the user asks for a workflow or reusable pipeline.
        The code runs in the same sandboxed REPL as eval — all libraries and tools are available.
        IMPORTANT: Write workflows as exported async functions, then call them at the bottom.
        This allows saved workflows to be composed via import { fn } from "name".
      `,
      metadata: { ls_code_input_language: "javascript" },
      schema: z.object({
        name: z
          .string()
          .describe(
            "Short kebab-case name for the workflow (e.g. review-and-verify)",
          ),
        description: z
          .string()
          .describe("One-line description of what this workflow does"),
        code: z
          .string()
          .describe("TypeScript/JavaScript code for the workflow pipeline"),
      }),
    },
  );

  const listWorkflowsTool = tool(
    async () => {
      const entries: string[] = [];

      if (workflowDrafts.size > 0) {
        entries.push("**Drafts:**");
        for (const w of workflowDrafts.values()) {
          entries.push(`- ${w.name}: ${w.description}`);
        }
      }

      const saved = allLibraries.filter((lib) => !libraries.includes(lib));
      if (saved.length > 0) {
        entries.push("**Saved (available as libraries):**");
        for (const lib of saved) {
          entries.push(`- ${lib.name}: ${lib.description}`);
        }
      }

      return entries.length > 0 ? entries.join("\n") : "No workflows found.";
    },
    {
      name: "list_workflows",
      description:
        "List all workflow drafts and permanently saved workflows.",
      schema: z.object({}),
    },
  );

  const saveWorkflowTool = tool(
    async (input) => {
      const draft = workflowDrafts.get(input.name);
      if (!draft) {
        return `No draft workflow named "${input.name}" found. Run it first with run_workflow.`;
      }

      const lib: InterpreterLibrary = {
        name: draft.name,
        description: draft.description,
        ptcTools: [],
        source: draft.code,
        instructions: [
          `Saved workflow: ${draft.description}`,
          `Import exported functions: \`import { fn } from "${draft.name}"\``,
          `Call the imported functions to compose with this workflow.`,
        ].join("\n"),
      };

      allLibraries.push(lib);
      workflowDrafts.delete(input.name);

      return (
        `Workflow "${input.name}" saved as an interpreter library. ` +
        `It will be available via \`import "${input.name}"\` on subsequent turns.`
      );
    },
    {
      name: "save_workflow",
      description:
        "Promote a draft workflow to a permanent interpreter library that can be imported on future turns.",
      schema: z.object({
        name: z
          .string()
          .describe("Name of the draft workflow to save permanently"),
      }),
    },
  );

  const deleteWorkflowTool = tool(
    async (input) => {
      if (workflowDrafts.has(input.name)) {
        workflowDrafts.delete(input.name);
        return `Draft workflow "${input.name}" deleted.`;
      }

      const idx = allLibraries.findIndex(
        (lib) => lib.name === input.name && !libraries.includes(lib),
      );
      if (idx !== -1) {
        allLibraries.splice(idx, 1);
        return `Saved workflow "${input.name}" deleted. It will no longer be importable.`;
      }

      return `Workflow "${input.name}" not found.`;
    },
    {
      name: "delete_workflow",
      description:
        "Delete a draft or saved workflow. Saved workflows are removed from the library list.",
      schema: z.object({
        name: z.string().describe("Name of the workflow to delete"),
      }),
    },
  );

  const workflowTools = enableWorkflows
    ? [runWorkflowTool, listWorkflowsTool, saveWorkflowTool, deleteWorkflowTool]
    : [];

  const workflowPrompt = enableWorkflows
    ? dedent`

      ### Workflows

      Workflow tools are available for composing reusable pipelines:

      - **\`run_workflow\`**: Execute a pipeline and save it as a draft. Use this instead of \`eval\` when the user asks for a "workflow" or reusable pipeline. The code runs in the same interpreter — all libraries and tools are available.
      - **\`list_workflows\`**: List draft and saved workflows.
      - **\`save_workflow\`**: Promote a draft to a permanent interpreter library. Once saved, the workflow becomes importable via \`import "workflow-name"\` on future turns — just like any other library.
      - **\`delete_workflow\`**: Delete a draft or saved workflow.

      **When to use \`run_workflow\` vs \`eval\`:**
      - Use \`run_workflow\` when the user explicitly asks for a workflow, pipeline, or reusable process.
      - Use \`eval\` for one-off computations, data exploration, and scratch work.

      **IMPORTANT — Writing workflows:**
      Workflows MUST be written as exported async functions, not top-level scripts.
      This is required so that saved workflows can be composed — importing a workflow
      should give the caller access to callable functions, not trigger side effects.

      Correct:
      \`\`\`javascript
      export async function quickReview(files) {
        const table = await create({ files });
        await run(table.id, { instruction: "Review {file}", subagentType: "reviewer" });
        return rows(table.id);
      }
      const result = await quickReview(["src/a.ts", "src/b.ts"]);
      console.log(JSON.stringify(result));
      \`\`\`

      Wrong (top-level script — cannot be composed):
      \`\`\`javascript
      const table = await create({ files: ["src/a.ts"] });
      await run(table.id, { ... });
      const result = await rows(table.id);
      console.log(result);
      \`\`\`

      **Composing workflows:**
      When building a workflow that uses a previously saved one, import its exported
      functions and call them — do NOT rely on side effects from \`import\`.

      \`\`\`javascript
      import { quickReview } from "quick-review";
      export async function reviewAndSummarize(files) {
        const results = await quickReview(files);
        return \`Found \${results.length} issues across \${files.length} files\`;
      }
      const summary = await reviewAndSummarize(["src/a.ts", "src/b.ts"]);
      console.log(summary);
      \`\`\`
    `
    : "";

  // --------------- end workflow tools ---------------

  const ptcToolNames = new Set(
    aggregatedPtc.map((t) => (typeof t === "string" ? t : t.name)),
  );

  const mw = createMiddleware({
    name: "CodeInterpreterMiddleware",
    tools: [evalTool, ...workflowTools],
    beforeAgent(state) {
      if (!skillsBackend) return;

      const metadata: SkillMetadata[] =
        ((state as Record<string, unknown>)
          .skillsMetadata as SkillMetadata[]) ?? [];

      for (const skill of metadata) {
        const rawPtc = skill.metadata?.["required-ptc-tools"] ?? "";
        const requiredPtc = rawPtc
          ? String(rawPtc).split(/\s+/).filter(Boolean)
          : [];
        const missing = requiredPtc.filter((t) => !ptcToolNames.has(t));
        if (missing.length > 0) {
          throw new Error(
            `Skill '${skill.name}' requires PTC tools that are not configured: ${missing.join(", ")}. ` +
              `Add them to createQuickJSMiddleware({ ptc: [...] }).`,
          );
        }
      }
    },
    wrapModelCall: async (request, handler) => {
      const agentTools = (request.tools || []) as StructuredToolInterface[];
      ptcTools = filterToolsForPtc(agentTools);

      if (ptcTools.length > 0 && !cachedPtcPrompt) {
        cachedPtcPrompt = await generatePtcPrompt(ptcTools);
      }

      librariesPrompt = renderLibrariesPrompt(allLibraries);

      const systemMessage = request.systemMessage
        .concat(baseSystemPrompt)
        .concat(cachedPtcPrompt || "")
        .concat(librariesPrompt)
        .concat(workflowPrompt);
      return handler({ ...request, systemMessage });
    },
    afterAgent: async (_state, runtime) => {
      const threadId = runtime.configurable?.thread_id ?? DEFAULT_SESSION_ID;
      const sessionKey = `${threadId}:${middlewareId}`;
      ReplSession.deleteSession(sessionKey);
    },
  });

  // Collect subagent pool refs from libraries so createDeepAgent can
  // discover and populate them during agent construction.
  const subagentPoolRefs = libraries
    .map((lib) => lib.subagentPool)
    .filter((ref): ref is SubagentPoolRef => ref != null);

  return Object.assign(mw, { _subagentPoolRefs: subagentPoolRefs });
}
