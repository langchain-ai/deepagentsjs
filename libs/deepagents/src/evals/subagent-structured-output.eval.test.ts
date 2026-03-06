/**
 * Eval suite: Subagent Structured Output vs Text Returns
 *
 * Tests whether giving subagents a `responseFormat` (structured output)
 * improves the parent agent's ability to use subagent results compared
 * to the current behavior where subagent results are flattened to text
 * in a ToolMessage.
 *
 * Each eval case runs the same task with two agent configurations:
 *   A ("text"): subagent returns free-text (current behavior)
 *   B ("structured"): subagent returns structured output via responseFormat
 *
 * Scoring dimensions:
 *   - field_accuracy: did exact values survive the subagent→parent transfer?
 *   - aggregation_accuracy: when merging multiple subagent results, is the merge correct?
 *   - step_count: did the parent need extra steps to parse/re-extract?
 *
 * All results are logged to LangSmith for side-by-side experiment comparison.
 */

import * as ls from "langsmith/vitest";
import { expect } from "vitest";
import { tool } from "langchain";
import { z } from "zod/v4";
import { createDeepAgent, runAgent, getFinalText } from "./index.js";

// ---------------------------------------------------------------------------
// Fake tools that return realistic, detail-rich data
// ---------------------------------------------------------------------------

/**
 * Returns a financial record with precise numbers that are easy to
 * corrupt during text summarization (decimal precision, currency codes,
 * negative values, ISO dates).
 */
const lookupFinancialRecord = tool(
  async ({ ticker }) => {
    const records: Record<string, string> = {
      AAPL: JSON.stringify({
        ticker: "AAPL",
        price: 187.44,
        change: -2.31,
        change_pct: -1.22,
        currency: "USD",
        market_cap_billions: 2910.5,
        pe_ratio: 29.87,
        date: "2025-01-15T16:00:00Z",
      }),
      TSLA: JSON.stringify({
        ticker: "TSLA",
        price: 352.76,
        change: 8.19,
        change_pct: 2.38,
        currency: "USD",
        market_cap_billions: 1132.4,
        pe_ratio: 96.12,
        date: "2025-01-15T16:00:00Z",
      }),
      SAP: JSON.stringify({
        ticker: "SAP",
        price: 236.18,
        change: -0.47,
        change_pct: -0.2,
        currency: "EUR",
        market_cap_billions: 289.3,
        pe_ratio: 82.55,
        date: "2025-01-15T17:30:00Z",
      }),
    };
    return records[ticker] ?? `No data found for ${ticker}`;
  },
  {
    name: "lookup_financial_record",
    description:
      "Look up current financial data for a stock ticker. Returns price, change, market cap, PE ratio.",
    schema: z.object({
      ticker: z.string().describe("Stock ticker symbol (e.g. AAPL)"),
    }),
  },
);

/**
 * Returns patient lab results with values that require exact
 * preservation — units, reference ranges, flags.
 */
const getLabResults = tool(
  async ({ patient_id }) => {
    const results: Record<string, string> = {
      "PT-4821": JSON.stringify({
        patient_id: "PT-4821",
        collected_at: "2025-01-14T08:30:00Z",
        results: [
          {
            test: "HbA1c",
            value: 6.8,
            unit: "%",
            reference_range: "4.0-5.6",
            flag: "HIGH",
          },
          {
            test: "Fasting Glucose",
            value: 128,
            unit: "mg/dL",
            reference_range: "70-100",
            flag: "HIGH",
          },
          {
            test: "Total Cholesterol",
            value: 195,
            unit: "mg/dL",
            reference_range: "< 200",
            flag: "NORMAL",
          },
          {
            test: "LDL",
            value: 132,
            unit: "mg/dL",
            reference_range: "< 100",
            flag: "HIGH",
          },
          {
            test: "HDL",
            value: 42,
            unit: "mg/dL",
            reference_range: "> 40",
            flag: "NORMAL",
          },
          {
            test: "Triglycerides",
            value: 187,
            unit: "mg/dL",
            reference_range: "< 150",
            flag: "HIGH",
          },
          {
            test: "Creatinine",
            value: 0.94,
            unit: "mg/dL",
            reference_range: "0.7-1.3",
            flag: "NORMAL",
          },
          {
            test: "eGFR",
            value: 88,
            unit: "mL/min/1.73m2",
            reference_range: "> 60",
            flag: "NORMAL",
          },
        ],
      }),
    };
    return results[patient_id] ?? `No results for patient ${patient_id}`;
  },
  {
    name: "get_lab_results",
    description:
      "Retrieve laboratory test results for a patient by ID. Returns all recent lab values with reference ranges and flags.",
    schema: z.object({
      patient_id: z.string().describe("Patient ID (e.g. PT-4821)"),
    }),
  },
);

/**
 * Returns product inventory data with nested attributes —
 * SKUs, precise quantities, locations, dimensions.
 */
const getInventory = tool(
  async ({ warehouse }) => {
    const data: Record<string, string> = {
      "WH-EAST": JSON.stringify({
        warehouse_id: "WH-EAST",
        location: "Newark, NJ",
        items: [
          {
            sku: "ELC-TV-55X",
            name: '55" OLED TV',
            quantity: 142,
            unit_price: 1299.99,
            weight_kg: 18.2,
            zone: "A3",
          },
          {
            sku: "ELC-TV-65X",
            name: '65" OLED TV',
            quantity: 87,
            unit_price: 1899.99,
            weight_kg: 24.7,
            zone: "A3",
          },
          {
            sku: "AUD-HP-PRO",
            name: "Pro Wireless Headphones",
            quantity: 531,
            unit_price: 349.95,
            weight_kg: 0.32,
            zone: "B1",
          },
        ],
        last_audit: "2025-01-10T14:00:00Z",
      }),
      "WH-WEST": JSON.stringify({
        warehouse_id: "WH-WEST",
        location: "Ontario, CA",
        items: [
          {
            sku: "ELC-TV-55X",
            name: '55" OLED TV',
            quantity: 203,
            unit_price: 1299.99,
            weight_kg: 18.2,
            zone: "C1",
          },
          {
            sku: "ELC-TV-65X",
            name: '65" OLED TV',
            quantity: 64,
            unit_price: 1899.99,
            weight_kg: 24.7,
            zone: "C1",
          },
          {
            sku: "AUD-HP-PRO",
            name: "Pro Wireless Headphones",
            quantity: 892,
            unit_price: 349.95,
            weight_kg: 0.32,
            zone: "D2",
          },
        ],
        last_audit: "2025-01-12T09:00:00Z",
      }),
    };
    return data[warehouse] ?? `No data for warehouse ${warehouse}`;
  },
  {
    name: "get_inventory",
    description:
      "Get current inventory for a warehouse. Returns items with SKU, quantity, price, weight, and zone.",
    schema: z.object({
      warehouse: z.string().describe("Warehouse ID (e.g. WH-EAST, WH-WEST)"),
    }),
  },
);

/**
 * Returns a structured event log with timestamps, codes, and severity
 * levels — the kind of data where text paraphrasing loses information.
 */
const getSystemEvents = tool(
  async ({ service }) => {
    const events: Record<string, string> = {
      "api-gateway": JSON.stringify({
        service: "api-gateway",
        time_range: {
          start: "2025-01-15T00:00:00Z",
          end: "2025-01-15T12:00:00Z",
        },
        events: [
          {
            timestamp: "2025-01-15T02:14:33Z",
            code: "GW-5012",
            severity: "CRITICAL",
            message: "Connection pool exhausted",
            affected_endpoints: 14,
            duration_ms: 4320,
          },
          {
            timestamp: "2025-01-15T02:21:07Z",
            code: "GW-5012",
            severity: "CRITICAL",
            message: "Connection pool exhausted (recurring)",
            affected_endpoints: 14,
            duration_ms: 1890,
          },
          {
            timestamp: "2025-01-15T06:45:19Z",
            code: "GW-3001",
            severity: "WARNING",
            message: "Elevated p99 latency",
            affected_endpoints: 3,
            duration_ms: 0,
          },
          {
            timestamp: "2025-01-15T09:30:00Z",
            code: "GW-1001",
            severity: "INFO",
            message: "Config reload completed",
            affected_endpoints: 0,
            duration_ms: 0,
          },
        ],
        summary: {
          total_events: 4,
          critical: 2,
          warning: 1,
          info: 1,
        },
      }),
    };
    return events[service] ?? `No events for service ${service}`;
  },
  {
    name: "get_system_events",
    description:
      "Retrieve system events for a service over the last 12 hours. Returns timestamped events with severity codes.",
    schema: z.object({
      service: z.string().describe("Service name (e.g. api-gateway)"),
    }),
  },
);

// ---------------------------------------------------------------------------
// Helper: run a task with both text-return and structured-return subagents
// ---------------------------------------------------------------------------

interface FieldCheck {
  /** Dot-path into the output file/text to locate the value (for human reference) */
  description: string;
  /** The exact string that must appear in the parent's final output (text or file) */
  expected: string;
}

/**
 * Score how many of the expected field values appear in the agent's output.
 * Searches both the final text response and all files.
 */
function scoreFieldAccuracy(
  finalText: string,
  files: Record<string, string>,
  checks: FieldCheck[],
): { score: number; total: number; failures: string[] } {
  const allOutput = [finalText, ...Object.values(files)]
    .join("\n")
    .toLowerCase();

  const failures: string[] = [];
  let matched = 0;

  for (const check of checks) {
    if (allOutput.includes(check.expected.toLowerCase())) {
      matched++;
    } else {
      failures.push(`Missing "${check.expected}" (${check.description})`);
    }
  }

  return { score: matched, total: checks.length, failures };
}

// ---------------------------------------------------------------------------
// Eval suite
// ---------------------------------------------------------------------------

ls.describe("subagent-structured-output", () => {
  // =========================================================================
  // CASE 1: Numeric precision under transfer
  //
  // WHY THIS MATTERS: Financial data has precise decimals, negative numbers,
  // and percentages. When a subagent returns "AAPL dropped 1.22% to $187.44",
  // the parent might round, reformat, or lose the sign. Structured output
  // preserves exact values.
  //
  // WHAT WE'RE MEASURING: Does the parent write a CSV/table with the exact
  // numbers from the subagent, or does it introduce drift?
  // =========================================================================

  ls.test(
    "numeric-precision: single stock lookup → CSV row",
    {
      inputs: {
        query:
          "Use the stock_data_agent subagent to look up AAPL data, then write a CSV file to /output.csv with columns: ticker,price,change,change_pct,currency,market_cap_billions,pe_ratio,date. Use the exact values from the lookup — do not round or reformat.",
      },
      referenceOutputs: {
        expected_fields: [
          "AAPL",
          "187.44",
          "-2.31",
          "-1.22",
          "USD",
          "2910.5",
          "29.87",
          "2025-01-15T16:00:00Z",
        ],
      },
    },
    async ({ inputs }) => {
      const agent = createDeepAgent({
        systemPrompt:
          "You are a data assistant. When asked to write files, use exact values from tool results. Never round numbers or reformat dates.",
        subagents: [
          {
            name: "stock_data_agent",
            description:
              "Use this agent to look up stock/financial data for any ticker",
            systemPrompt:
              "You are a financial data agent. Use the lookup_financial_record tool to get stock data. Return the data exactly as received.",
            tools: [lookupFinancialRecord],
          },
        ],
      });

      const result = await runAgent(agent, { query: inputs.query });

      const checks: FieldCheck[] = [
        { description: "ticker", expected: "AAPL" },
        { description: "price", expected: "187.44" },
        { description: "change (negative)", expected: "-2.31" },
        { description: "change_pct (negative)", expected: "-1.22" },
        { description: "currency code", expected: "USD" },
        { description: "market_cap_billions", expected: "2910.5" },
        { description: "pe_ratio", expected: "29.87" },
        { description: "ISO date", expected: "2025-01-15T16:00:00Z" },
      ];

      const { score, total, failures } = scoreFieldAccuracy(
        getFinalText(result),
        result.files,
        checks,
      );

      ls.logFeedback({ key: "field_accuracy", score: score / total });
      ls.logFeedback({ key: "field_accuracy_raw", score });
      ls.logFeedback({ key: "field_accuracy_total", score: total });
      ls.logFeedback({ key: "agent_steps", score: result.steps.length });

      if (failures.length > 0) {
        ls.logFeedback({
          key: "field_failures",
          score: 0,
          comment: failures.join("; "),
        });
      }

      expect(score).toBeGreaterThanOrEqual(6);
    },
  );

  // =========================================================================
  // CASE 2: Multi-subagent aggregation
  //
  // WHY THIS MATTERS: This is the strongest case for structured output.
  // When 3 subagents each return text about different stocks, the parent
  // has to parse 3 natural-language blobs to build a comparison table.
  // Field confusion (which number belongs to which stock?) is the primary
  // failure mode.
  //
  // WHAT WE'RE MEASURING: Can the parent correctly attribute all values
  // to the right entity when building a merged table?
  // =========================================================================

  ls.test(
    "multi-subagent-aggregation: 3 stocks → comparison table",
    {
      inputs: {
        query: [
          "I need a comparison of three stocks. For EACH of the following tickers, use the stock_data_agent subagent to look up data: AAPL, TSLA, SAP.",
          "Launch all three lookups in parallel.",
          "Then write a markdown table to /comparison.md with columns: Ticker | Price | Change % | Currency | Market Cap ($B) | P/E Ratio",
          "Use exact values from the lookups — do not round.",
        ].join("\n"),
      },
      referenceOutputs: {
        aapl_price: "187.44",
        tsla_price: "352.76",
        sap_price: "236.18",
      },
    },
    async ({ inputs }) => {
      const agent = createDeepAgent({
        systemPrompt:
          "You are a financial analyst assistant. When building comparison tables, use exact values from your data sources. Do not round numbers. Launch parallel subagent calls when looking up multiple tickers.",
        subagents: [
          {
            name: "stock_data_agent",
            description:
              "Use this agent to look up stock/financial data for a single ticker. Call it once per ticker.",
            systemPrompt:
              "You are a financial data agent. Use the lookup_financial_record tool to get stock data. Return all fields exactly as received from the tool.",
            tools: [lookupFinancialRecord],
          },
        ],
      });

      const result = await runAgent(agent, { query: inputs.query });

      const checks: FieldCheck[] = [
        // AAPL values attributed to AAPL row
        { description: "AAPL ticker", expected: "AAPL" },
        { description: "AAPL price", expected: "187.44" },
        { description: "AAPL change_pct", expected: "-1.22" },
        { description: "AAPL market_cap", expected: "2910.5" },
        { description: "AAPL pe_ratio", expected: "29.87" },
        // TSLA values attributed to TSLA row
        { description: "TSLA ticker", expected: "TSLA" },
        { description: "TSLA price", expected: "352.76" },
        { description: "TSLA change_pct", expected: "2.38" },
        { description: "TSLA market_cap", expected: "1132.4" },
        { description: "TSLA pe_ratio", expected: "96.12" },
        // SAP values attributed to SAP row
        { description: "SAP ticker", expected: "SAP" },
        { description: "SAP price", expected: "236.18" },
        { description: "SAP change_pct", expected: "-0.20" },
        { description: "SAP currency (EUR not USD)", expected: "EUR" },
        { description: "SAP market_cap", expected: "289.3" },
        { description: "SAP pe_ratio", expected: "82.55" },
      ];

      const { score, total, failures } = scoreFieldAccuracy(
        getFinalText(result),
        result.files,
        checks,
      );

      ls.logFeedback({ key: "field_accuracy", score: score / total });
      ls.logFeedback({ key: "field_accuracy_raw", score });
      ls.logFeedback({ key: "field_accuracy_total", score: total });
      ls.logFeedback({ key: "agent_steps", score: result.steps.length });

      // Check parallel subagent invocation (all 3 task calls in one step)
      const firstStep = result.steps[0];
      const taskCalls =
        firstStep?.action.tool_calls?.filter((tc) => tc.name === "task") ?? [];
      ls.logFeedback({
        key: "parallel_subagent_calls",
        score: taskCalls.length,
      });

      if (failures.length > 0) {
        ls.logFeedback({
          key: "field_failures",
          score: 0,
          comment: failures.join("; "),
        });
      }

      // Even text-return should get at least 12/16 right; structured should get 16/16
      expect(score).toBeGreaterThanOrEqual(12);
    },
  );

  // =========================================================================
  // CASE 3: High-cardinality structured data passthrough
  //
  // WHY THIS MATTERS: Lab results have 8 tests each with 5 fields (test name,
  // value, unit, reference range, flag). That's 40 data points. Text
  // summarization inevitably drops or paraphrases some — "cholesterol is
  // normal" loses the exact value (195) and reference range (< 200).
  //
  // WHAT WE'RE MEASURING: How many of the 40 data points survive the
  // subagent→parent→file pipeline intact?
  // =========================================================================

  ls.test(
    "high-cardinality: lab results → structured report file",
    {
      inputs: {
        query: [
          "Use the lab_results_agent subagent to retrieve lab results for patient PT-4821.",
          "Then write a JSON file to /report.json with this exact structure:",
          "{",
          '  "patient_id": "...",',
          '  "collected_at": "...",',
          '  "flagged_results": [',
          '    { "test": "...", "value": ..., "unit": "...", "reference_range": "...", "flag": "HIGH" }',
          "  ],",
          '  "normal_results": [',
          '    { "test": "...", "value": ..., "unit": "...", "reference_range": "...", "flag": "NORMAL" }',
          "  ]",
          "}",
          "Include ALL 8 test results, split into flagged vs normal. Use exact values.",
        ].join("\n"),
      },
    },
    async ({ inputs }) => {
      const agent = createDeepAgent({
        systemPrompt:
          "You are a medical data assistant. When writing reports, preserve all data exactly. Do not round lab values. Include all tests.",
        subagents: [
          {
            name: "lab_results_agent",
            description:
              "Use this agent to retrieve patient lab results by patient ID",
            systemPrompt:
              "You are a lab results agent. Use the get_lab_results tool to retrieve patient data. Return all results exactly as received.",
            tools: [getLabResults],
          },
        ],
      });

      const result = await runAgent(agent, { query: inputs.query });

      // Check that specific precise values survived
      const checks: FieldCheck[] = [
        { description: "patient_id", expected: "PT-4821" },
        {
          description: "collection timestamp",
          expected: "2025-01-14T08:30:00Z",
        },
        // Flagged results (HIGH) — exact values matter
        { description: "HbA1c value", expected: "6.8" },
        { description: "HbA1c unit", expected: "%" },
        { description: "HbA1c range", expected: "4.0-5.6" },
        { description: "Fasting Glucose value", expected: "128" },
        { description: "Fasting Glucose range", expected: "70-100" },
        { description: "LDL value", expected: "132" },
        { description: "LDL range", expected: "< 100" },
        { description: "Triglycerides value", expected: "187" },
        { description: "Triglycerides range", expected: "< 150" },
        // Normal results — these are more likely to be dropped in text summaries
        { description: "Total Cholesterol value", expected: "195" },
        { description: "Total Cholesterol range", expected: "< 200" },
        { description: "HDL value", expected: "42" },
        { description: "Creatinine value", expected: "0.94" },
        { description: "Creatinine range", expected: "0.7-1.3" },
        { description: "eGFR value", expected: "88" },
        { description: "eGFR unit", expected: "mL/min/1.73m2" },
      ];

      const { score, total, failures } = scoreFieldAccuracy(
        getFinalText(result),
        result.files,
        checks,
      );

      ls.logFeedback({ key: "field_accuracy", score: score / total });
      ls.logFeedback({ key: "field_accuracy_raw", score });
      ls.logFeedback({ key: "field_accuracy_total", score: total });
      ls.logFeedback({ key: "agent_steps", score: result.steps.length });

      if (failures.length > 0) {
        ls.logFeedback({
          key: "field_failures",
          score: 0,
          comment: failures.join("; "),
        });
      }

      // Expecting most values to survive — text return may lose some normal results
      expect(score).toBeGreaterThanOrEqual(12);
    },
  );

  // =========================================================================
  // CASE 4: Cross-subagent computation
  //
  // WHY THIS MATTERS: The parent must do arithmetic on values from two
  // different subagents (total inventory across warehouses). This is where
  // text returns are most dangerous — if the parent misreads "142" as "141"
  // from a text blob, the sum is wrong. Structured output removes ambiguity.
  //
  // WHAT WE'RE MEASURING: Are the computed totals correct? Are per-warehouse
  // values correctly attributed?
  // =========================================================================

  ls.test(
    "cross-subagent-computation: inventory across 2 warehouses → totals",
    {
      inputs: {
        query: [
          "I need an inventory rollup across our two warehouses.",
          "Use the inventory_agent subagent to get inventory for WH-EAST and WH-WEST (in parallel).",
          "Then write a report to /rollup.md with:",
          "1. A table showing each SKU, the quantity in each warehouse, and the total quantity across both",
          "2. The total combined inventory value (quantity × unit_price) per SKU across both warehouses",
          "Use exact numbers from the data. Show your math.",
        ].join("\n"),
      },
      referenceOutputs: {
        // ELC-TV-55X: 142 + 203 = 345, value = 345 × 1299.99 = 448,496.55
        // ELC-TV-65X: 87 + 64 = 151, value = 151 × 1899.99 = 286,898.49
        // AUD-HP-PRO: 531 + 892 = 1423, value = 1423 × 349.95 = 497,978.85
        expected_totals: {
          "ELC-TV-55X": { qty: 345, value: 448496.55 },
          "ELC-TV-65X": { qty: 151, value: 286898.49 },
          "AUD-HP-PRO": { qty: 1423, value: 497978.85 },
        },
      },
    },
    async ({ inputs }) => {
      const agent = createDeepAgent({
        systemPrompt:
          "You are an inventory analyst. Compute totals accurately. Show your arithmetic. Use exact values from data sources.",
        subagents: [
          {
            name: "inventory_agent",
            description:
              "Use this agent to get current inventory for a specific warehouse",
            systemPrompt:
              "You are an inventory data agent. Use the get_inventory tool to retrieve warehouse data. Return all item details exactly as received.",
            tools: [getInventory],
          },
        ],
      });

      const result = await runAgent(agent, { query: inputs.query });

      // Source data checks — did the raw values transfer correctly?
      const sourceChecks: FieldCheck[] = [
        // Per-warehouse quantities
        { description: "WH-EAST ELC-TV-55X qty", expected: "142" },
        { description: "WH-WEST ELC-TV-55X qty", expected: "203" },
        { description: "WH-EAST ELC-TV-65X qty", expected: "87" },
        { description: "WH-WEST ELC-TV-65X qty", expected: "64" },
        { description: "WH-EAST AUD-HP-PRO qty", expected: "531" },
        { description: "WH-WEST AUD-HP-PRO qty", expected: "892" },
        // Unit prices
        { description: "TV-55X unit price", expected: "1299.99" },
        { description: "TV-65X unit price", expected: "1899.99" },
        { description: "HP-PRO unit price", expected: "349.95" },
      ];

      // Computed totals — did the parent do the math right?
      const computedChecks: FieldCheck[] = [
        { description: "ELC-TV-55X total qty", expected: "345" },
        { description: "ELC-TV-65X total qty", expected: "151" },
        { description: "AUD-HP-PRO total qty", expected: "1423" },
      ];

      const sourceResult = scoreFieldAccuracy(
        getFinalText(result),
        result.files,
        sourceChecks,
      );
      const computedResult = scoreFieldAccuracy(
        getFinalText(result),
        result.files,
        computedChecks,
      );

      ls.logFeedback({
        key: "source_field_accuracy",
        score: sourceResult.score / sourceResult.total,
      });
      ls.logFeedback({
        key: "computed_field_accuracy",
        score: computedResult.score / computedResult.total,
      });
      ls.logFeedback({
        key: "field_accuracy",
        score:
          (sourceResult.score + computedResult.score) /
          (sourceResult.total + computedResult.total),
      });
      ls.logFeedback({ key: "agent_steps", score: result.steps.length });

      const allFailures = [
        ...sourceResult.failures,
        ...computedResult.failures,
      ];
      if (allFailures.length > 0) {
        ls.logFeedback({
          key: "field_failures",
          score: 0,
          comment: allFailures.join("; "),
        });
      }

      // Source values should mostly survive even with text returns
      expect(sourceResult.score).toBeGreaterThanOrEqual(6);
      // Computed totals are the harder test
      expect(computedResult.score).toBeGreaterThanOrEqual(2);
    },
  );

  // =========================================================================
  // CASE 5: Conditional branching on subagent output
  //
  // WHY THIS MATTERS: The parent must make a DECISION based on specific
  // field values from the subagent — severity level, error codes, counts.
  // With text returns, the parent has to parse "there were 2 critical events"
  // to decide what to do. Structured output makes the branch condition
  // unambiguous.
  //
  // WHAT WE'RE MEASURING: Does the parent take the correct action based on
  // the subagent's data? (Not just "did it mention the right thing" but
  // "did it make the right decision?")
  // =========================================================================

  ls.test(
    "conditional-branching: incident severity → correct escalation action",
    {
      inputs: {
        query: [
          "Check the api-gateway service for incidents using the incident_agent subagent.",
          "Based on the results, write an action plan to /action.md following these rules:",
          "- If there are ANY critical events: write 'ESCALATION: PAGE ON-CALL' as the first line",
          "- If critical events have error code GW-5012: add 'ACTION: Scale connection pool' ",
          "- For each critical event, include the exact timestamp and duration_ms",
          "- If there are warnings: add 'MONITOR: [event code]' lines",
          "- End with 'TOTAL_EVENTS: [count]' and 'CRITICAL_COUNT: [count]'",
        ].join("\n"),
      },
    },
    async ({ inputs }) => {
      const agent = createDeepAgent({
        systemPrompt:
          "You are an incident response coordinator. Follow escalation rules exactly. Use precise values from incident data.",
        subagents: [
          {
            name: "incident_agent",
            description:
              "Use this agent to check system events and incidents for a service",
            systemPrompt:
              "You are a monitoring agent. Use the get_system_events tool to retrieve events. Return all event details exactly as received.",
            tools: [getSystemEvents],
          },
        ],
      });

      const result = await runAgent(agent, { query: inputs.query });

      // Decision checks — did the parent make the right calls?
      const decisionChecks: FieldCheck[] = [
        {
          description: "escalation triggered (critical exists)",
          expected: "PAGE ON-CALL",
        },
        {
          description: "correct action for GW-5012",
          expected: "connection pool",
        },
        {
          description: "monitoring for warning code",
          expected: "GW-3001",
        },
      ];

      // Data precision checks
      const dataChecks: FieldCheck[] = [
        {
          description: "first critical timestamp",
          expected: "2025-01-15T02:14:33Z",
        },
        {
          description: "first critical duration",
          expected: "4320",
        },
        {
          description: "second critical timestamp",
          expected: "2025-01-15T02:21:07Z",
        },
        {
          description: "second critical duration",
          expected: "1890",
        },
        { description: "total event count", expected: "4" },
        { description: "critical count", expected: "2" },
        { description: "critical event code", expected: "GW-5012" },
      ];

      const decisionResult = scoreFieldAccuracy(
        getFinalText(result),
        result.files,
        decisionChecks,
      );
      const dataResult = scoreFieldAccuracy(
        getFinalText(result),
        result.files,
        dataChecks,
      );

      ls.logFeedback({
        key: "decision_accuracy",
        score: decisionResult.score / decisionResult.total,
      });
      ls.logFeedback({
        key: "data_precision",
        score: dataResult.score / dataResult.total,
      });
      ls.logFeedback({
        key: "field_accuracy",
        score:
          (decisionResult.score + dataResult.score) /
          (decisionResult.total + dataResult.total),
      });
      ls.logFeedback({ key: "agent_steps", score: result.steps.length });

      const allFailures = [...decisionResult.failures, ...dataResult.failures];
      if (allFailures.length > 0) {
        ls.logFeedback({
          key: "field_failures",
          score: 0,
          comment: allFailures.join("; "),
        });
      }

      // Decisions should almost always be correct even with text
      expect(decisionResult.score).toBeGreaterThanOrEqual(2);
      // Data precision is where structured output should shine
      expect(dataResult.score).toBeGreaterThanOrEqual(4);
    },
  );
});
