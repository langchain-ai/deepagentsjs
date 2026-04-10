/**
 * Playwright E2E tests: fully in-browser deep agent with wasmsh sandbox.
 *
 * Everything runs in the browser — no backend service involved:
 * - wasmsh shell/Python execution via browser Web Worker
 * - LLM calls via ChatAnthropic with dangerouslyAllowBrowser
 * - createDeepAgent orchestrates the agent with full middleware stack
 *
 * Requires: built Pyodide assets + ANTHROPIC_API_KEY
 */
import { test, expect, type Page } from "@playwright/test";

const API_KEY = process.env.ANTHROPIC_API_KEY;

test.skip(!API_KEY, "ANTHROPIC_API_KEY not set");

async function runBrowserTest(page: Page, testName: string) {
  await page.goto(`/?key=${encodeURIComponent(API_KEY!)}&test=${testName}`);

  // Wait for completion (boot + agent run)
  await page.waitForFunction(
    () => {
      try {
        const data = JSON.parse(
          document.getElementById("result")?.textContent ?? "{}",
        );
        return data.status === "done" || data.status === "error";
      } catch {
        return false;
      }
    },
    { timeout: 120_000 },
  );

  const resultText = await page.textContent("#result");
  const result = JSON.parse(resultText!);

  if (result.status === "error") {
    // eslint-disable-next-line no-console -- test diagnostics
    console.error(`[${testName}] error:`, result.message);
  }

  return result;
}

test("csv analysis: Python computes correct statistics", async ({ page }) => {
  test.setTimeout(120_000);
  const result = await runBrowserTest(page, "csv");

  expect(result.status).toBe("done");
  expect(result.exitCode).toBe(0);
  expect(result.analysis.average).toBe(21);
  expect(result.analysis.hottest_city).toBe("Cairo");
  expect(result.analysis.hottest_temp).toBe(35);
});

test("skills: agent loads SKILL.md from sandbox and follows instructions", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const result = await runBrowserTest(page, "skills");

  expect(result.status).toBe("done");
  // Verify the table was written and contains expected data
  expect(result.table).toContain("Alice");
  expect(result.table).toContain("Carol");
  expect(result.table).toContain("|");
  // Verify the summary JSON
  expect(result.summary.count).toBe(3);
  expect(result.summary.top_scorer).toBe("Carol");
});

test("filesystem: edit and write_file work", async ({ page }) => {
  test.setTimeout(120_000);
  const result = await runBrowserTest(page, "filesystem");

  expect(result.status).toBe("done");
  expect(result.mainContainsGoodbye).toBe(true);
  expect(result.mainNotHello).toBe(true);
  expect(result.configExists).toBe(true);
});

test("memory: agent uses AGENTS.md context from sandbox", async ({ page }) => {
  test.setTimeout(120_000);
  const result = await runBrowserTest(page, "memory");

  expect(result.status).toBe("done");
  const d = result.deploy;
  // These values are only available from the memory file
  const region = d.region?.toLowerCase() ?? "";
  expect(region.includes("frankfurt") || region.includes("eu-central")).toBe(
    true,
  );
  expect(d.unit_system?.toLowerCase()).toContain("metric");
  expect(d.team_lead).toContain("Weber");
  expect(d.database?.toLowerCase()).toContain("postgres");
});

test("code execution: Python computes median and stddev", async ({ page }) => {
  test.setTimeout(120_000);
  const result = await runBrowserTest(page, "code");

  expect(result.status).toBe("done");
  const s = result.stats;
  expect(s.sorted).toEqual([3, 10, 17, 25, 42, 56, 64, 73, 88, 91]);
  expect(s.median).toBe(49);
  expect(s.stddev).toBeGreaterThan(29);
  expect(s.stddev).toBeLessThan(32);
});
