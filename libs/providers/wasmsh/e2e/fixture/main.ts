/**
 * Browser agent test dispatcher.
 *
 * Runs createDeepAgent entirely in the browser with a wasmsh browser Worker
 * sandbox. No backend service involved. The ?test= query param selects the
 * scenario; ?key= provides the Anthropic API key.
 */
import { ChatAnthropic } from "@langchain/anthropic";
import { HumanMessage } from "@langchain/core/messages";
import { createDeepAgent } from "deepagents";

import { BrowserSandbox } from "./browser-sandbox.js";

const enc = new TextEncoder();

function report(data: Record<string, unknown>) {
  document.getElementById("result")!.textContent = JSON.stringify(data);
}

function makeModel(apiKey: string) {
  return new ChatAnthropic({
    model: "claude-haiku-4-5-20251001",
    apiKey,
    clientOptions: { dangerouslyAllowBrowser: true },
  });
}

// ── Test: CSV analysis ──────────────────────────────────────

async function testCsvAnalysis(sandbox: BrowserSandbox, apiKey: string) {
  await sandbox.uploadFiles([
    [
      "/workspace/temps.csv",
      enc.encode(
        "city,temp_c\nTokyo,22\nBerlin,15\nCairo,35\nSydney,28\nOslo,5\n",
      ),
    ],
  ]);

  const agent = createDeepAgent({ model: makeModel(apiKey), backend: sandbox });
  await agent.invoke({
    messages: [
      new HumanMessage(
        "Analyze the CSV file at /workspace/temps.csv. Calculate the average temperature " +
          "and find the hottest city. Write the results as JSON to /workspace/analysis.json " +
          'with keys "average", "hottest_city", and "hottest_temp".',
      ),
    ],
  });

  const catResult = await sandbox.execute("cat /workspace/analysis.json");
  return {
    status: "done",
    exitCode: catResult.exitCode,
    analysis: JSON.parse(catResult.output.trim()),
  };
}

// ── Test: Skill loading ─────────────────────────────────────

async function testSkillLoading(sandbox: BrowserSandbox, apiKey: string) {
  const skillMd = [
    "---",
    "name: md-table-formatter",
    "description: Format data as a markdown table and write it to a file",
    "---",
    "",
    "When asked to format data, you MUST:",
    "1. Create a markdown table with columns: Name, Score, Grade",
    "2. Assign grades: A for score >= 90, B for score >= 80, C otherwise",
    "3. Write the table to /workspace/output.md",
    "4. Write a JSON summary to /workspace/summary.json with keys:",
    '   - "count" (number of rows)',
    '   - "top_scorer" (name of the person with highest score)',
    "",
  ].join("\n");

  await sandbox.execute("mkdir -p /workspace/skills/md-table-formatter");
  await sandbox.uploadFiles([
    ["/workspace/skills/md-table-formatter/SKILL.md", enc.encode(skillMd)],
  ]);

  const agent = createDeepAgent({
    model: makeModel(apiKey),
    backend: sandbox,
    skills: ["/workspace/skills"],
  });

  await agent.invoke({
    messages: [
      new HumanMessage(
        "Use the md-table-formatter skill to format this student data: Alice 92, Bob 85, Carol 97",
      ),
    ],
  });

  const tableResult = await sandbox.execute("cat /workspace/output.md");
  const summaryResult = await sandbox.execute("cat /workspace/summary.json");
  return {
    status: "done",
    table: tableResult.output,
    summary: JSON.parse(summaryResult.output.trim()),
  };
}

// ── Test: Filesystem reliability ────────────────────────────

async function testFilesystem(sandbox: BrowserSandbox, apiKey: string) {
  await sandbox.execute("mkdir -p /workspace/project/src");
  await sandbox.uploadFiles([
    ["/workspace/project/src/main.py", enc.encode('print("hello world")\n')],
    [
      "/workspace/project/src/utils.py",
      enc.encode("def add(a, b):\n    return a + b\n"),
    ],
    ["/workspace/project/README.md", enc.encode("# My Project\n")],
  ]);

  const agent = createDeepAgent({ model: makeModel(apiKey), backend: sandbox });
  await agent.invoke({
    messages: [
      new HumanMessage(
        'Edit /workspace/project/src/main.py to change "hello" to "goodbye". ' +
          "Then create a new file /workspace/project/src/config.py with the content: DEBUG = True",
      ),
    ],
  });

  const mainResult = await sandbox.execute(
    "cat /workspace/project/src/main.py",
  );
  const configResult = await sandbox.execute(
    "cat /workspace/project/src/config.py",
  );

  return {
    status: "done",
    mainContainsGoodbye: mainResult.output.includes("goodbye"),
    mainNotHello: !mainResult.output.includes("hello"),
    configExists: configResult.exitCode === 0,
    configContent: configResult.output,
  };
}

// ── Test: Memory usage ──────────────────────────────────────

async function testMemory(sandbox: BrowserSandbox, apiKey: string) {
  const memoryContent = [
    "# Agent Memory",
    "",
    "## Project Configuration",
    "- Deployment region: eu-central-1 (Frankfurt)",
    "- Unit system: metric (Celsius, meters, kilograms)",
    "- Team lead: Dr. Weber",
    "- Database: PostgreSQL 16",
    "- Default language: German",
    "",
  ].join("\n");

  await sandbox.execute("mkdir -p /workspace/memory");
  await sandbox.uploadFiles([
    ["/workspace/memory/AGENTS.md", enc.encode(memoryContent)],
  ]);

  const agent = createDeepAgent({
    model: makeModel(apiKey),
    backend: sandbox,
    memory: ["/workspace/memory/AGENTS.md"],
  });

  await agent.invoke({
    messages: [
      new HumanMessage(
        "Write a deployment config to /workspace/deploy.json with our project's " +
          '"region", "unit_system", "team_lead", and "database".',
      ),
    ],
  });

  const deployResult = await sandbox.execute("cat /workspace/deploy.json");
  return { status: "done", deploy: JSON.parse(deployResult.output.trim()) };
}

// ── Test: Code execution (Python + shell) ───────────────────

async function testCodeExecution(sandbox: BrowserSandbox, apiKey: string) {
  await sandbox.execute("mkdir -p /workspace/data");
  await sandbox.uploadFiles([
    [
      "/workspace/data/numbers.txt",
      enc.encode("42\n17\n88\n3\n56\n91\n25\n64\n10\n73\n"),
    ],
  ]);

  const agent = createDeepAgent({ model: makeModel(apiKey), backend: sandbox });
  await agent.invoke({
    messages: [
      new HumanMessage(
        "Read /workspace/data/numbers.txt, sort the numbers, compute the median and " +
          "population standard deviation. Write the results to /workspace/data/stats.json " +
          'with keys "sorted" (array), "median" (number), "stddev" (rounded to 1 decimal).',
      ),
    ],
  });

  const statsResult = await sandbox.execute("cat /workspace/data/stats.json");
  return { status: "done", stats: JSON.parse(statsResult.output.trim()) };
}

// ── Dispatcher ──────────────────────────────────────────────

const TESTS: Record<
  string,
  (s: BrowserSandbox, k: string) => Promise<Record<string, unknown>>
> = {
  csv: testCsvAnalysis,
  skills: testSkillLoading,
  filesystem: testFilesystem,
  memory: testMemory,
  code: testCodeExecution,
};

async function run() {
  const params = new URLSearchParams(location.search);
  const apiKey = params.get("key");
  const testName = params.get("test") ?? "csv";

  if (!apiKey) {
    report({ status: "error", message: "Missing ?key= query parameter" });
    return;
  }

  const testFn = TESTS[testName];
  if (!testFn) {
    report({ status: "error", message: `Unknown test: ${testName}` });
    return;
  }

  report({ status: "booting" });

  const sandbox = new BrowserSandbox({
    workerUrl: "/worker/browser-worker.js",
    assetBaseUrl: "/assets",
  });
  await sandbox.initialize();

  report({ status: "agent_running" });

  try {
    const result = await testFn(sandbox, apiKey);
    report(result);
  } finally {
    await sandbox.stop();
  }
}

run().catch((err) => {
  report({ status: "error", message: err.message, stack: err.stack });
});
