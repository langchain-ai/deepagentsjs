import * as ls from "langsmith/vitest";
import type { EvalRunner } from "@deepagents/evals";
import {
  createCodeInterpreterMiddleware,
  createSwarmTaskTool,
  swarm,
} from "@langchain/quickjs";
import type { SubagentPoolRef } from "deepagents";
import {
  generateTickets,
  generateCodeFiles,
  generateAuthModules,
} from "./fixtures.js";
import {
  scoreClassification,
  scoreVulnerabilities,
  scoreGenerateFilter,
  measureSteps,
  ARTIFACT_PATH,
} from "./scoring.js";
import { judgeOutput, judgePattern } from "./judge.js";
import { verifyPattern } from "./verification.js";
import { recordRun } from "./results.js";

// ---------------------------------------------------------------------------
// Subagent definitions (shared across conditions)
// ---------------------------------------------------------------------------

const CLASSIFIER = {
  name: "classifier",
  description: "Classifies support tickets by category.",
  systemPrompt:
    "You classify support tickets into exactly one category: billing, technical, account, or other. " +
    "Read the ticket body carefully. Return the category and a one-sentence reason. " +
    "Do not ask for more information. Classify based on what is provided.",
};

const HANDLER = {
  name: "handler",
  description: "Performs detailed analysis on urgent support tickets.",
  systemPrompt:
    "You analyze urgent support tickets in detail. Identify the core issue, " +
    "assess business impact, and recommend an immediate action. " +
    "Be concise. One paragraph per ticket.",
};

const REVIEWER = {
  name: "reviewer",
  description: "Reviews code for security vulnerabilities.",
  systemPrompt:
    "You review code for security vulnerabilities: SQL injection, path traversal, " +
    "XSS, command injection, insecure deserialization, and prototype pollution. " +
    "Cite line numbers. Ignore style issues. " +
    "Read only the assigned file. Do not explore other files. " +
    "Produce findings after one read.",
};

const BUG_FINDER = {
  name: "bug-finder",
  description: "Finds bugs and security issues in code.",
  systemPrompt:
    "You find bugs and security vulnerabilities in code. " +
    "Focus on: SQL injection, path traversal, XSS, command injection, " +
    "insecure deserialization, and prototype pollution. " +
    "Cite line numbers and describe each finding. " +
    "Read only the assigned file. Produce findings after one read.",
};

const VERIFIER = {
  name: "verifier",
  description: "Independently verifies whether a reported bug is real.",
  systemPrompt:
    "You are a skeptical code reviewer. Given a SPECIFIC reported bug in a " +
    "named file, read that file and decide if the finding is real or a false " +
    "positive, and whether it is actually exploitable. " +
    "Verify ONLY the reported finding in the file named in the task. Do NOT " +
    "grep or search the broader codebase, and do not explore other files — " +
    "decide from the cited file alone, after one read. " +
    "Return confirmed=true or confirmed=false with a reason.",
};

const TEST_GENERATOR = {
  name: "test-generator",
  description: "Generates test cases for a given module.",
  systemPrompt:
    "You generate test cases for code modules. " +
    "Each test should have a name, description, input, and expected behavior. " +
    "Be specific and concrete. Include edge cases.",
};

const EVALUATOR = {
  name: "evaluator",
  description: "Evaluates and scores test cases for quality and uniqueness.",
  systemPrompt:
    "You evaluate test cases for quality. Score each test on coverage value (1-5) " +
    "and flag duplicates. A test is a duplicate if it tests the same behavior " +
    "as another test even if the inputs differ slightly.",
};

// ---------------------------------------------------------------------------
// Runner factories for the two conditions
// ---------------------------------------------------------------------------

/**
 * REPL library instructions for the baseline condition.
 *
 * The baseline agent uses the plain `task` tool via programmatic tool
 * calling in the REPL (`tools.task()`). This gives orchestration guidance
 * comparable to what swarm's library instructions provide — parallel
 * fanout, multi-stage composition, effective dispatch descriptions, and
 * result handling — but without the table abstraction.
 */
const BASELINE_TASK_INSTRUCTIONS = `\
## Dispatching subagents with \`tools.task\`

\`tools.task\` is your primitive for running subagents. You orchestrate
everything else — multi-stage flow, filtering, dedup, synthesis — in
plain JavaScript in the REPL.

### The primitive

\`\`\`javascript
await tools.task({
  description,      // the full task prompt for this dispatch
  subagent_type,    // name of the subagent to dispatch to
}); // -> Promise<string>  (the subagent's final text response)
\`\`\`

Each dispatch runs a full agentic loop — the subagent has tools and can
iterate. The return value is the subagent's final text response as a string.

### Mental model

Hold your work in JS: an array of items in, an array of results out. You
merge each dispatch's result back onto its item. Multi-stage analysis =
run a pass, filter the array in JS, run another pass over the survivors.

### Fan out with bounded concurrency

Dispatch in parallel with \`Promise.all\`, in batches (~10) so you don't
launch hundreds at once:

\`\`\`javascript
async function mapConcurrent(items, fn, batch = 10) {
  const out = [];
  for (let i = 0; i < items.length; i += batch) {
    out.push(...(await Promise.all(items.slice(i, i + batch).map(fn))));
  }
  return out;
}

const reviewed = await mapConcurrent(items, async (it) => {
  const raw = await tools.task({
    description: "Review " + it.file + " for SQL injection and missing auth checks. " +
      "Cite line numbers.",
    subagent_type: "reviewer",
  });
  return { ...it, raw };
});
\`\`\`

### Compose multiple stages — filter the array in JS between passes

\`\`\`javascript
// Stage 1 — classify all items
const tagged = await mapConcurrent(items, async (it) => {
  const raw = await tools.task({
    description: "Classify " + it.file + " as handler, util, or test.",
    subagent_type: "classifier",
  });
  return { ...it, raw };
});

// Stage 2 — only handlers (you do the filtering)
const handlers = tagged.filter((it) => it.raw.includes("handler"));
const reviewed = await mapConcurrent(handlers, async (it) => {
  // ... review dispatch ...
});
\`\`\`

### Write effective dispatch descriptions

Subagents run a full agentic loop; vague descriptions waste iterations.
Put BOTH the specific ask AND the constraints in \`description\`: say
exactly what to find and what NOT to do ("Analyze only this file; do not
read imports or grep the codebase"). Read a representative file first so
you know what to ask for.

### Get results out without flooding your context

Keep results in JS variables — never \`console.log\` the full result set.
To produce a human-facing summary, dispatch a SYNTHESIS subagent over
your collected findings; that keeps the raw data out of YOUR context:

\`\`\`javascript
const report = await tools.task({
  description: "Write a security report grouped by file from these findings:\\n" +
    JSON.stringify(confirmed),
  subagent_type: "reviewer",
});
console.log(report); // only the synthesized text crosses back
\`\`\`

If the findings are too large for one synthesis call, chunk them,
synthesize per chunk, then combine. Persist full structured output from
inside the eval:
\`await tools.writeFile({ file_path: "/results/output.json", content: JSON.stringify(results) })\`.

### Across evals

Variables persist across eval calls within a turn, but re-establish what
you need each eval. Doing the whole workflow in one eval is simplest.
Everything resets between separate user turns.`;


/**
 * REPL library instructions for the swarm_task condition.
 *
 * Same orchestration-in-JS approach as baseline, but uses the `swarm_task`
 * PTC tool which adds structured output via `response_schema` and cheap
 * single-call dispatch via invoke mode.
 */
const SWARM_TASK_INSTRUCTIONS = `\
## Dispatching subagents with \`tools.swarmTask\`

\`tools.swarmTask\` is your primitive for running subagents. You orchestrate
everything else — multi-stage flow, filtering, dedup, synthesis — in
plain JavaScript in the REPL.

### The primitive

\`\`\`javascript
// Agent mode — full agentic loop with tools (subagent reads files, iterates)
await tools.swarmTask({
  description,      // the full task prompt
  subagent_type,    // name of the subagent to dispatch to (required for agent mode)
  response_schema,  // optional JSON Schema — response is parsed JSON string
}); // -> Promise<string>

// Invoke mode — single model call, no tools, no iteration
// Use for classification, extraction, labeling — anything that doesn't need file access
await tools.swarmTask({
  description,      // the full task prompt (include all data inline)
  mode: "invoke",
  response_schema,  // optional JSON Schema — forces structured output
}); // -> Promise<string>
\`\`\`

**Agent mode** (default): runs a full agentic loop — the subagent has
tools and can read files, iterate, etc. Requires \`subagent_type\`.

**Invoke mode**: a single model call with no tools. Much faster and
cheaper. Use when the prompt contains everything the model needs (e.g.
classification or extraction over data you already have). Pass
\`mode: "invoke"\`.

**response_schema**: when provided, the response is guaranteed to match
the schema. The return value is a JSON string — parse it with
\`JSON.parse()\`. Works in both modes.

### Mental model

Hold your work in JS: an array of items in, an array of results out. You
merge each dispatch's result back onto its item. Multi-stage analysis =
run a pass, filter the array in JS, run another pass over the survivors.

### Fan out with bounded concurrency

Dispatch in parallel with \`Promise.all\`, in batches (~10) so you don't
launch hundreds at once:

\`\`\`javascript
async function mapConcurrent(items, fn, batch = 10) {
  const out = [];
  for (let i = 0; i < items.length; i += batch) {
    out.push(...(await Promise.all(items.slice(i, i + batch).map(fn))));
  }
  return out;
}

// Invoke mode for cheap classification
const classified = await mapConcurrent(items, async (it) => {
  const raw = await tools.swarmTask({
    description: "Classify this ticket: " + it.body,
    mode: "invoke",
    response_schema: {
      type: "object",
      properties: {
        category: { type: "string" },
        urgency: { type: "string" },
      },
      required: ["category", "urgency"],
    },
  });
  return { ...it, ...JSON.parse(raw) };
});

// Agent mode for deep analysis (subagent reads files)
const reviewed = await mapConcurrent(items, async (it) => {
  const raw = await tools.swarmTask({
    description: "Review " + it.file + " for SQL injection. Cite line numbers.",
    subagent_type: "reviewer",
  });
  return { ...it, raw };
});
\`\`\`

### When to use invoke vs agent mode

- **Invoke mode**: classification, extraction, labeling, summarization —
  any task where you can put all the data in the prompt. Pre-read file
  content and pass it in \`description\`. Fast and cheap.
- **Agent mode**: tasks that need tool access — reading files, searching,
  multi-step reasoning. The subagent gets a full tool set and iterates.

### Pre-read content for invoke mode

Invoke mode has no tools, so the subagent can't read files. Read content
upfront and include it in the prompt:

\`\`\`javascript
const files = (await tools.glob({ pattern: "src/**/*.ts" })).split("\\n").filter(Boolean);
const items = await Promise.all(
  files.map(async (f) => {
    const content = await tools.readFile({ file_path: f });
    return { file: f, content };
  })
);

const results = await mapConcurrent(items, async (it) => {
  const raw = await tools.swarmTask({
    description: "Review this code for vulnerabilities:\\n" + it.content,
    mode: "invoke",
    response_schema: {
      type: "object",
      properties: { vulnerabilities: { type: "array", items: { type: "object", properties: { type: { type: "string" }, line: { type: "number" } } } } },
      required: ["vulnerabilities"],
    },
  });
  return { ...it, ...JSON.parse(raw) };
});
\`\`\`

### Compose multiple stages — filter the array in JS between passes

\`\`\`javascript
// Stage 1 — classify (invoke mode, cheap)
const tagged = await mapConcurrent(items, async (it) => {
  const raw = await tools.swarmTask({
    description: "Classify " + it.file + " as handler, util, or test.",
    mode: "invoke",
    response_schema: {
      type: "object",
      properties: { kind: { type: "string" } },
      required: ["kind"],
    },
  });
  return { ...it, ...JSON.parse(raw) };
});

// Stage 2 — deep review only handlers (agent mode)
const handlers = tagged.filter((it) => it.kind === "handler");
const reviewed = await mapConcurrent(handlers, async (it) => {
  const raw = await tools.swarmTask({
    description: "Deep security review of " + it.file,
    subagent_type: "reviewer",
  });
  return { ...it, raw };
});
\`\`\`

### Get results out without flooding your context

Keep results in JS variables — never \`console.log\` the full result set.
Persist structured output from inside the eval:
\`await tools.writeFile({ file_path: "/results/output.json", content: JSON.stringify(results) })\`.

### Across evals

Variables persist across eval calls within a turn, but re-establish what
you need each eval. Doing the whole workflow in one eval is simplest.
Everything resets between separate user turns.`;


function swarmCondition(
  runner: EvalRunner,
  subagents: Record<string, unknown>[],
): EvalRunner {
  return runner.extend({
    middleware: [
      createCodeInterpreterMiddleware({
        libraries: [swarm()],
        executionTimeoutMs: -1,
        maxPtcCalls: null,
      }),
    ],
    subagents,
  });
}

function baselineCondition(
  runner: EvalRunner,
  subagents: Record<string, unknown>[],
): EvalRunner {
  return runner.extend({
    middleware: [
      createCodeInterpreterMiddleware({
        libraries: [
          {
            name: "dispatch",
            description:
              "Direct subagent dispatch — call tools.task({...}); nothing to import.",
            ptcTools: ["task", "read_file", "write_file", "edit_file", "glob"],
            source:
              'export const README = "Use tools.task() to dispatch subagents.";',
            files: new Map(),
            instructions: BASELINE_TASK_INSTRUCTIONS,
          },
        ],
        executionTimeoutMs: -1,
        maxPtcCalls: null,
      }),
    ],
    subagents,
  });
}

function swarmTaskCondition(
  runner: EvalRunner,
  subagents: Record<string, unknown>[],
): EvalRunner {
  const subagentPool: SubagentPoolRef = { current: null };
  const swarmTaskTool = createSwarmTaskTool({ subagentPool });

  return runner.extend({
    middleware: [
      createCodeInterpreterMiddleware({
        libraries: [
          {
            name: "dispatch",
            description:
              "Subagent dispatch with structured output — call tools.swarmTask({...}); nothing to import.",
            ptcTools: [
              swarmTaskTool,
              "read_file",
              "write_file",
              "edit_file",
              "glob",
            ],
            source:
              'export const README = "Use tools.swarmTask() to dispatch subagents.";',
            files: new Map(),
            instructions: SWARM_TASK_INSTRUCTIONS,
            subagentPool,
          },
        ],
        executionTimeoutMs: -1,
        maxPtcCalls: null,
      }),
    ],
    subagents,
  });
}

type Condition = (typeof CONDITIONS)[number];

function getConditionRunner(
  condition: Condition,
  runner: EvalRunner,
  subagents: Record<string, unknown>[],
): EvalRunner {
  switch (condition) {
    case "swarm":
      return swarmCondition(runner, subagents);
    case "swarm_task":
      return swarmTaskCondition(runner, subagents);
    case "baseline":
      return baselineCondition(runner, subagents);
  }
}

// ---------------------------------------------------------------------------
// Eval suite
// ---------------------------------------------------------------------------

const SCALES = [50, 200, 500, 1000] as const;
const CONDITIONS = ["baseline", "swarm_task", "swarm"] as const;

/**
 * Zero-padded scale tag for test names (e.g. `N=0050`). Fixed width so no
 * scale is a substring-prefix of another — `vitest -t "N=0050"` then matches
 * exactly one scale (plain `N=50` would also match `N=500`).
 */
function scaleTag(scale: number): string {
  return `N=${String(scale).padStart(4, "0")}`;
}

// ---------------------------------------------------------------------------
// Output contract — both conditions must write structured results here so
// scoring is deterministic and condition-fair (no trajectory string-scanning).
// ---------------------------------------------------------------------------

const ARTIFACT_INSTRUCTIONS: Record<string, string> = {
  "classify-and-act":
    `When finished, write your results to ${ARTIFACT_PATH} as a JSON array — ` +
    "one object per ticket: " +
    `{ "file": <ticket file path>, "category": one of "billing"|"technical"|"account"|"other", "urgent": boolean }.`,
  "fanout-and-synthesize":
    `When finished, write your results to ${ARTIFACT_PATH} as a JSON array — ` +
    "one object per file you reviewed: " +
    `{ "file": <source file path>, "vulnerabilities": [ { "type": <vulnerability type> } ] }. ` +
    "Use an empty vulnerabilities array for clean files.",
  "adversarial-verification":
    `When finished, write your results to ${ARTIFACT_PATH} as a JSON array — ` +
    "one object per file: " +
    `{ "file": <source file path>, "vulnerabilities": [ { "type": <vulnerability type> } ] }. ` +
    "Include ONLY confirmed vulnerabilities; use an empty array for files with none.",
  "generate-and-filter":
    `When finished, write your final, deduplicated test set to ${ARTIFACT_PATH} ` +
    "as a JSON array — one object per module: " +
    `{ "module": <module path>, "tests": [ { "name": string, "angle": one of "happy"|"error"|"security" } ] }.`,
  "loop-until-done":
    `When finished, write your results to ${ARTIFACT_PATH} as a JSON array — ` +
    "one object per file with findings: " +
    `{ "file": <source file path>, "vulnerabilities": [ { "type": <vulnerability type> } ] }. ` +
    "Include every distinct confirmed vulnerability you found across all rounds.",
};

/**
 * Append the per-pattern results-artifact contract to a task query. The
 * same contract is given to both conditions so scoring is fair.
 */
function withArtifact(_pattern: string, query: string): string {
  return query;
}

export function swarmSuite(runner: EvalRunner): void {
  // -----------------------------------------------------------------------
  // Pattern 1 — Classify-And-Act
  // -----------------------------------------------------------------------

  for (const scale of SCALES) {
    for (const condition of CONDITIONS) {
      const runName = `classify-and-act: ${condition} @ ${scaleTag(scale)}`;
      ls.test(
        runName,
        {
          inputs: { pattern: "classify-and-act", condition, scale },
        },
        async () => {
          const { files, groundTruth } = generateTickets(scale);

          const conditionRunner = getConditionRunner(condition, runner, [
            CLASSIFIER,
            HANDLER,
          ]);

          const query = withArtifact(
            "classify-and-act",
            "Classify each support ticket in /tickets/ by category " +
              "(billing, technical, account, or other) and do a detailed " +
              "analysis on the urgent ones.",
          );

          const result = await conditionRunner.run({
            query,
            initialFiles: files,
            runName,
          });

          const score = scoreClassification(result, groundTruth);

          ls.logFeedback({ key: "artifact_valid", score: score.artifactValid });
          ls.logFeedback({ key: "coverage", score: score.coverage });
          ls.logFeedback({ key: "category_accuracy", score: score.categoryAccuracy });
          ls.logFeedback({ key: "urgent_recall", score: score.urgentRecall });
          ls.logFeedback({ key: "urgent_precision", score: score.urgentPrecision });
          ls.logFeedback({ key: "items_total", score: groundTruth.length });
          ls.logFeedback({ key: "steps", score: measureSteps(result) });

          const judgeResult = await judgeOutput(result, "classify-and-act", query);
          ls.logFeedback({ key: "judge_score", score: judgeResult.score });
          ls.logFeedback({ key: "judge_reasoning", score: judgeResult.score, comment: judgeResult.reasoning });

          const patternJudge = await judgePattern(result, "classify-and-act", condition);
          ls.logFeedback({ key: "pattern_verified", score: patternJudge.score });
          ls.logFeedback({ key: "pattern_reasoning", score: patternJudge.score, comment: patternJudge.reasoning });

          const mechanical = verifyPattern(result, "classify-and-act", condition);
          ls.logFeedback({ key: "pattern_verified_mechanical", score: mechanical.score, comment: mechanical.details.join("; ") });

          recordRun({ pattern: "classify-and-act", condition, scale }, score, judgeResult, patternJudge);
        },
      );
    }
  }

  // -----------------------------------------------------------------------
  // Pattern 2 — Fanout-And-Synthesize
  // -----------------------------------------------------------------------

  for (const scale of SCALES) {
    for (const condition of CONDITIONS) {
      const runName = `fanout-and-synthesize: ${condition} @ ${scaleTag(scale)}`;
      ls.test(
        runName,
        {
          inputs: { pattern: "fanout-and-synthesize", condition, scale },
        },
        async () => {
          const { files, groundTruth } = generateCodeFiles(scale);

          const conditionRunner = getConditionRunner(condition, runner, [
            REVIEWER,
          ]);

          const query = withArtifact(
            "fanout-and-synthesize",
            "Review every TypeScript file in /src/ for security " +
              "vulnerabilities and give me a summary of what you found.",
          );

          const result = await conditionRunner.run({
            query,
            initialFiles: files,
            runName,
          });

          const paths = Object.keys(files);
          const score = scoreVulnerabilities(result, groundTruth, paths);

          ls.logFeedback({ key: "artifact_valid", score: score.artifactValid });
          ls.logFeedback({ key: "coverage", score: score.coverage });
          ls.logFeedback({ key: "recall", score: score.recall });
          ls.logFeedback({ key: "precision", score: score.precision });
          ls.logFeedback({ key: "vulns_found", score: score.found });
          ls.logFeedback({ key: "vulns_expected", score: score.expected });
          ls.logFeedback({ key: "vulns_reported", score: score.reported });
          ls.logFeedback({ key: "false_positives", score: score.falsePositives });
          ls.logFeedback({ key: "steps", score: measureSteps(result) });

          const judgeResult = await judgeOutput(result, "fanout-and-synthesize", query);
          ls.logFeedback({ key: "judge_score", score: judgeResult.score });
          ls.logFeedback({ key: "judge_reasoning", score: judgeResult.score, comment: judgeResult.reasoning });

          const patternJudge = await judgePattern(result, "fanout-and-synthesize", condition);
          ls.logFeedback({ key: "pattern_verified", score: patternJudge.score });
          ls.logFeedback({ key: "pattern_reasoning", score: patternJudge.score, comment: patternJudge.reasoning });

          const mechanical = verifyPattern(result, "fanout-and-synthesize", condition);
          ls.logFeedback({ key: "pattern_verified_mechanical", score: mechanical.score, comment: mechanical.details.join("; ") });

          recordRun({ pattern: "fanout-and-synthesize", condition, scale }, score, judgeResult, patternJudge);
        },
      );
    }
  }

  // -----------------------------------------------------------------------
  // Pattern 3 — Adversarial Verification
  // -----------------------------------------------------------------------

  for (const scale of SCALES) {
    for (const condition of CONDITIONS) {
      const runName = `adversarial-verification: ${condition} @ ${scaleTag(scale)}`;
      ls.test(
        runName,
        {
          inputs: { pattern: "adversarial-verification", condition, scale },
        },
        async () => {
          const { files, groundTruth } = generateCodeFiles(scale);

          const conditionRunner = getConditionRunner(condition, runner, [
            BUG_FINDER,
            VERIFIER,
          ]);

          const query = withArtifact(
            "adversarial-verification",
            "Find bugs in the files under /src/, then verify each " +
              "finding is real. Only report confirmed issues.",
          );

          const result = await conditionRunner.run({
            query,
            initialFiles: files,
            runName,
          });

          const paths = Object.keys(files);
          const score = scoreVulnerabilities(result, groundTruth, paths);

          ls.logFeedback({ key: "artifact_valid", score: score.artifactValid });
          ls.logFeedback({ key: "coverage", score: score.coverage });
          ls.logFeedback({ key: "recall", score: score.recall });
          ls.logFeedback({ key: "precision", score: score.precision });
          ls.logFeedback({ key: "vulns_found", score: score.found });
          ls.logFeedback({ key: "vulns_expected", score: score.expected });
          ls.logFeedback({ key: "vulns_reported", score: score.reported });
          ls.logFeedback({ key: "false_positives", score: score.falsePositives });
          ls.logFeedback({ key: "steps", score: measureSteps(result) });

          const judgeResult = await judgeOutput(result, "adversarial-verification", query);
          ls.logFeedback({ key: "judge_score", score: judgeResult.score });
          ls.logFeedback({ key: "judge_reasoning", score: judgeResult.score, comment: judgeResult.reasoning });

          const patternJudge = await judgePattern(result, "adversarial-verification", condition);
          ls.logFeedback({ key: "pattern_verified", score: patternJudge.score });
          ls.logFeedback({ key: "pattern_reasoning", score: patternJudge.score, comment: patternJudge.reasoning });

          const mechanical = verifyPattern(result, "adversarial-verification", condition);
          ls.logFeedback({ key: "pattern_verified_mechanical", score: mechanical.score, comment: mechanical.details.join("; ") });

          recordRun({ pattern: "adversarial-verification", condition, scale }, score, judgeResult, patternJudge);
        },
      );
    }
  }

  // -----------------------------------------------------------------------
  // Pattern 4 — Generate-And-Filter
  // -----------------------------------------------------------------------

  for (const scale of SCALES) {
    for (const condition of CONDITIONS) {
      const runName = `generate-and-filter: ${condition} @ ${scaleTag(scale)}`;
      ls.test(
        runName,
        {
          inputs: { pattern: "generate-and-filter", condition, scale },
        },
        async () => {
          const { files } = generateAuthModules(scale);

          const conditionRunner = getConditionRunner(condition, runner, [
            TEST_GENERATOR,
            EVALUATOR,
          ]);

          const query = withArtifact(
            "generate-and-filter",
            `Generate test cases for every module in /src/ (${scale} ` +
              "modules) from multiple angles — happy path, error handling, " +
              "and security. Deduplicate and keep only the unique, " +
              "high-value tests.",
          );

          const result = await conditionRunner.run({
            query,
            initialFiles: files,
            runName,
          });

          const score = scoreGenerateFilter(result, scale);

          ls.logFeedback({ key: "artifact_valid", score: score.artifactValid });
          ls.logFeedback({ key: "coverage", score: score.coverage });
          ls.logFeedback({ key: "test_count", score: score.testCount });
          ls.logFeedback({ key: "steps", score: measureSteps(result) });

          const judgeResult = await judgeOutput(result, "generate-and-filter", query);
          ls.logFeedback({ key: "judge_score", score: judgeResult.score });
          ls.logFeedback({ key: "judge_reasoning", score: judgeResult.score, comment: judgeResult.reasoning });

          const patternJudge = await judgePattern(result, "generate-and-filter", condition);
          ls.logFeedback({ key: "pattern_verified", score: patternJudge.score });
          ls.logFeedback({ key: "pattern_reasoning", score: patternJudge.score, comment: patternJudge.reasoning });

          const mechanical = verifyPattern(result, "generate-and-filter", condition);
          ls.logFeedback({ key: "pattern_verified_mechanical", score: mechanical.score, comment: mechanical.details.join("; ") });

          recordRun({ pattern: "generate-and-filter", condition, scale }, score, judgeResult, patternJudge);
        },
      );
    }
  }

  // -----------------------------------------------------------------------
  // Pattern 5 — Loop-Until-Done (exhaustive iterative discovery)
  // -----------------------------------------------------------------------

  for (const scale of SCALES) {
    for (const condition of CONDITIONS) {
      const runName = `loop-until-done: ${condition} @ ${scaleTag(scale)}`;
      ls.test(
        runName,
        {
          inputs: { pattern: "loop-until-done", condition, scale },
        },
        async () => {
          const { files, groundTruth } = generateCodeFiles(scale);

          const conditionRunner = getConditionRunner(condition, runner, [
            BUG_FINDER,
          ]);

          const query = withArtifact(
            "loop-until-done",
            "Exhaustively find EVERY security vulnerability across the " +
              "TypeScript files in /src/. Work iteratively: review the files, " +
              "then keep spawning additional review rounds targeting whatever " +
              "has not yet been covered, deduping against what you have " +
              "already found. STOP only when a full round surfaces no new " +
              "vulnerabilities. Completeness matters more than speed — do not " +
              "stop early.",
          );

          const result = await conditionRunner.run({
            query,
            initialFiles: files,
            runName,
          });

          const paths = Object.keys(files);
          const score = scoreVulnerabilities(result, groundTruth, paths);

          ls.logFeedback({ key: "artifact_valid", score: score.artifactValid });
          ls.logFeedback({ key: "coverage", score: score.coverage });
          ls.logFeedback({ key: "recall", score: score.recall });
          ls.logFeedback({ key: "precision", score: score.precision });
          ls.logFeedback({ key: "vulns_found", score: score.found });
          ls.logFeedback({ key: "vulns_expected", score: score.expected });
          ls.logFeedback({ key: "vulns_reported", score: score.reported });
          ls.logFeedback({ key: "false_positives", score: score.falsePositives });
          ls.logFeedback({ key: "steps", score: measureSteps(result) });

          const judgeResult = await judgeOutput(result, "loop-until-done", query);
          ls.logFeedback({ key: "judge_score", score: judgeResult.score });
          ls.logFeedback({ key: "judge_reasoning", score: judgeResult.score, comment: judgeResult.reasoning });

          const patternJudge = await judgePattern(result, "loop-until-done", condition);
          ls.logFeedback({ key: "pattern_verified", score: patternJudge.score });
          ls.logFeedback({ key: "pattern_reasoning", score: patternJudge.score, comment: patternJudge.reasoning });

          const mechanical = verifyPattern(result, "loop-until-done", condition);
          ls.logFeedback({ key: "pattern_verified_mechanical", score: mechanical.score, comment: mechanical.details.join("; ") });

          recordRun({ pattern: "loop-until-done", condition, scale }, score, judgeResult, patternJudge);
        },
      );
    }
  }
}
