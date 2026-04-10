/**
 * LLM-driven agent integration tests for WasmshSandbox.
 *
 * Creates deep agents with WasmshSandbox as backend to test:
 * - CSV analysis, skill loading, filesystem ops, memory, code execution
 *
 * Requires: built Pyodide assets + ANTHROPIC_API_KEY
 */
import { existsSync } from "node:fs";
import { describe, it, expect, afterEach } from "vitest";
import { HumanMessage } from "@langchain/core/messages";
import { createDeepAgent } from "deepagents";
import { resolveAssetPath } from "@mayflowergmbh/wasmsh-pyodide";

import { WasmshSandbox } from "./sandbox.js";

const assetsAvailable = existsSync(resolveAssetPath("pyodide.asm.wasm"));
const apiKeyAvailable = !!process.env.ANTHROPIC_API_KEY;
const SKIP = !assetsAvailable || !apiKeyAvailable;
const MODEL = "claude-haiku-4-5-20251001";
const enc = new TextEncoder();

describe("LLM agent integration via WasmshSandbox", () => {
  let sandbox: WasmshSandbox | undefined;

  afterEach(async () => {
    if (sandbox) {
      await sandbox.stop();
      sandbox = undefined;
    }
  });

  it.skipIf(SKIP)(
    "csv analysis: Python computes correct statistics",
    { timeout: 120_000 },
    async () => {
      sandbox = await WasmshSandbox.createNode({
        workingDirectory: "/workspace",
      });
      await sandbox.uploadFiles([
        [
          "/workspace/temps.csv",
          enc.encode(
            "city,temp_c\nTokyo,22\nBerlin,15\nCairo,35\nSydney,28\nOslo,5\n",
          ),
        ],
      ]);

      const agent = createDeepAgent({ model: MODEL, backend: sandbox });
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
      expect(catResult.exitCode).toBe(0);
      const analysis = JSON.parse(catResult.output.trim());
      expect(analysis.average).toBe(21);
      expect(analysis.hottest_city).toBe("Cairo");
      expect(analysis.hottest_temp).toBe(35);
    },
  );

  it.skipIf(SKIP)(
    "skills: agent loads SKILL.md and follows instructions",
    { timeout: 120_000 },
    async () => {
      sandbox = await WasmshSandbox.createNode({
        workingDirectory: "/workspace",
      });

      const skillMd =
        "---\nname: md-table-formatter\ndescription: Format data as a markdown table and write it to a file\n---\n\n" +
        "When asked to format data, you MUST:\n" +
        "1. Create a markdown table with columns: Name, Score, Grade\n" +
        "2. Assign grades: A for score >= 90, B for score >= 80, C otherwise\n" +
        "3. Write the table to /workspace/output.md\n" +
        "4. Write a JSON summary to /workspace/summary.json with keys:\n" +
        '   - "count" (number of rows)\n' +
        '   - "top_scorer" (name of the person with highest score)\n';

      await sandbox.execute("mkdir -p /workspace/skills/md-table-formatter");
      await sandbox.uploadFiles([
        ["/workspace/skills/md-table-formatter/SKILL.md", enc.encode(skillMd)],
      ]);

      const agent = createDeepAgent({
        model: MODEL,
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
      expect(tableResult.output).toContain("Alice");
      expect(tableResult.output).toContain("|");

      const summaryResult = await sandbox.execute(
        "cat /workspace/summary.json",
      );
      const summary = JSON.parse(summaryResult.output.trim());
      expect(summary.count).toBe(3);
      expect(summary.top_scorer).toBe("Carol");
    },
  );

  it.skipIf(SKIP)(
    "filesystem: edit and write_file work",
    { timeout: 120_000 },
    async () => {
      sandbox = await WasmshSandbox.createNode({
        workingDirectory: "/workspace",
      });

      await sandbox.execute("mkdir -p /workspace/project/src");
      await sandbox.uploadFiles([
        [
          "/workspace/project/src/main.py",
          enc.encode('print("hello world")\n'),
        ],
        [
          "/workspace/project/src/utils.py",
          enc.encode("def add(a, b):\n    return a + b\n"),
        ],
        ["/workspace/project/README.md", enc.encode("# My Project\n")],
      ]);

      const agent = createDeepAgent({ model: MODEL, backend: sandbox });
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
      expect(mainResult.output).toContain("goodbye");
      expect(mainResult.output).not.toContain("hello");

      const configResult = await sandbox.execute(
        "cat /workspace/project/src/config.py",
      );
      expect(configResult.exitCode).toBe(0);
    },
  );

  it.skipIf(SKIP)(
    "memory: agent uses AGENTS.md context from sandbox",
    { timeout: 120_000 },
    async () => {
      sandbox = await WasmshSandbox.createNode({
        workingDirectory: "/workspace",
      });

      const memoryContent =
        "# Agent Memory\n\n## Project Configuration\n" +
        "- Deployment region: eu-central-1 (Frankfurt)\n" +
        "- Unit system: metric (Celsius, meters, kilograms)\n" +
        "- Team lead: Dr. Weber\n" +
        "- Database: PostgreSQL 16\n";

      await sandbox.execute("mkdir -p /workspace/memory");
      await sandbox.uploadFiles([
        ["/workspace/memory/AGENTS.md", enc.encode(memoryContent)],
      ]);

      const agent = createDeepAgent({
        model: MODEL,
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
      const deploy = JSON.parse(deployResult.output.trim());
      const region = deploy.region?.toLowerCase() ?? "";
      expect(
        region.includes("frankfurt") || region.includes("eu-central"),
      ).toBe(true);
      expect(deploy.unit_system?.toLowerCase()).toContain("metric");
      expect(deploy.team_lead).toContain("Weber");
      expect(deploy.database?.toLowerCase()).toContain("postgres");
    },
  );

  it.skipIf(SKIP)(
    "code execution: Python computes median and stddev",
    { timeout: 120_000 },
    async () => {
      sandbox = await WasmshSandbox.createNode({
        workingDirectory: "/workspace",
      });

      await sandbox.execute("mkdir -p /workspace/data");
      await sandbox.uploadFiles([
        [
          "/workspace/data/numbers.txt",
          enc.encode("42\n17\n88\n3\n56\n91\n25\n64\n10\n73\n"),
        ],
      ]);

      const agent = createDeepAgent({ model: MODEL, backend: sandbox });
      await agent.invoke({
        messages: [
          new HumanMessage(
            "Read /workspace/data/numbers.txt, sort the numbers, compute the median and " +
              "population standard deviation. Write the results to /workspace/data/stats.json " +
              'with keys "sorted" (array), "median" (number), "stddev" (rounded to 1 decimal).',
          ),
        ],
      });

      const statsResult = await sandbox.execute(
        "cat /workspace/data/stats.json",
      );
      const stats = JSON.parse(statsResult.output.trim());
      expect(stats.sorted).toEqual([3, 10, 17, 25, 42, 56, 64, 73, 88, 91]);
      expect(stats.median).toBe(49);
      expect(stats.stddev).toBeGreaterThan(29);
      expect(stats.stddev).toBeLessThan(32);
    },
  );
});
