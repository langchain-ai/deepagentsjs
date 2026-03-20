/**
 * Oolong dataset loader.
 *
 * Fetches tasks from the HuggingFace datasets server API
 * (oolongbench/oolong-synth, validation split) and caches them locally
 * as JSONL in `.cache/tasks.jsonl`.
 *
 * Each row in the dataset represents one aggregation question over a
 * context window of labelled data. The agent must classify/count items
 * and answer distributional questions.
 *
 * Supports filtering by context_len and limiting tasks per source dataset
 * via environment variables.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface OolongTask {
  /** Unique row ID from the dataset. */
  id: number;
  /** Source dataset name (e.g. "spam", "trec_coarse", "ag_news"). */
  dataset: string;
  /** Context length bucket (1024, 4096, 32768, 131072). */
  contextLen: number;
  /** The full context text the agent must reason over. */
  contextWindowText: string;
  /** The aggregation question to answer. */
  question: string;
  /** Task group (e.g. "counting", "user", "temporal"). */
  taskGroup: string;
  /** Specific task type (e.g. "TASK_TYPE.MOST_FREQ", "TASK_TYPE.NUMERIC_ONE_CLASS"). */
  task: string;
  /** Gold answer (may be JSON-encoded Python list like "['spam']"). */
  answer: string;
  /** Answer type (e.g. "ANSWER_TYPE.LABEL", "ANSWER_TYPE.NUMERIC"). */
  answerType: string;
  /** Whether the question targets a subset of the data. */
  inputSubset: boolean;
  /** Number of distinct labels in the context. */
  numLabels: number;
  /** Context window group ID. */
  contextWindowId: number;
}

/** Shape of each row from the HuggingFace datasets server API. */
interface HfRow {
  id: number;
  context_len: number;
  dataset: string;
  context_window_text: string;
  question: string;
  task_group: string;
  task: string;
  answer: string;
  answer_type: string;
  input_subset: string;
  num_labels: number;
  context_window_id: number;
}

/** HF datasets server response shape. */
interface HfRowsResponse {
  rows: Array<{ row_idx: number; row: HfRow; truncated_cells: string[] }>;
  num_rows_total: number;
  num_rows_per_page: number;
}

const CACHE_DIR = join(import.meta.dirname, ".cache");
const CACHE_PATH = join(CACHE_DIR, "tasks.jsonl");

const HF_ROWS_URL =
  "https://datasets-server.huggingface.co/rows" +
  "?dataset=oolongbench/oolong-synth&config=default&split=validation";

const PAGE_SIZE = 100;

/**
 * Fetch ALL validation rows from HuggingFace and cache as JSONL.
 *
 * The validation split has ~1,300 rows across multiple source datasets
 * and context length buckets. We fetch all of them; filtering happens
 * at load time.
 */
async function fetchAndCache(): Promise<void> {
  mkdirSync(CACHE_DIR, { recursive: true });

  const allRows: HfRow[] = [];
  let offset = 0;

  // eslint-disable-next-line no-console
  console.log("Fetching Oolong validation split from HuggingFace...");

  while (true) {
    const url = `${HF_ROWS_URL}&offset=${offset}&length=${PAGE_SIZE}`;
    const resp = await fetch(url);
    if (!resp.ok) {
      throw new Error(
        `HuggingFace API error: ${resp.status} ${resp.statusText}\n${await resp.text()}`,
      );
    }
    const data = (await resp.json()) as HfRowsResponse;

    for (const { row } of data.rows) {
      allRows.push(row);
    }

    offset += data.rows.length;
    if (data.rows.length < PAGE_SIZE || offset >= data.num_rows_total) {
      break;
    }
  }

  if (allRows.length === 0) {
    throw new Error(
      "No rows found in oolongbench/oolong-synth validation split",
    );
  }

  const jsonl = allRows.map((r) => JSON.stringify(r)).join("\n") + "\n";
  writeFileSync(CACHE_PATH, jsonl, "utf-8");

  // eslint-disable-next-line no-console
  console.log(`Cached ${allRows.length} Oolong tasks -> ${CACHE_PATH}`);
}

function parseRow(row: HfRow): OolongTask {
  return {
    id: row.id,
    dataset: row.dataset,
    contextLen: row.context_len,
    contextWindowText: row.context_window_text,
    question: row.question,
    taskGroup: row.task_group,
    task: row.task,
    answer: row.answer,
    answerType: row.answer_type,
    inputSubset: row.input_subset === "True",
    numLabels: row.num_labels,
    contextWindowId: row.context_window_id,
  };
}

export interface LoadOptions {
  /**
   * Maximum number of tasks to load per source dataset.
   * Set to 0 or Infinity for no limit.
   * @default 10
   */
  maxPerDataset?: number;

  /**
   * Filter to a specific context_len value. If undefined, loads all.
   */
  contextLen?: number;
}

/**
 * Load Oolong tasks. Downloads from HuggingFace on first call, then
 * reads from `.cache/tasks.jsonl`.
 *
 * By default returns up to 10 tasks per source dataset for cost
 * efficiency. Set `maxPerDataset: 0` for the full validation split.
 *
 * Environment variable overrides:
 * - `OOLONG_MAX_PER_DATASET` — override maxPerDataset
 * - `OOLONG_CONTEXT_LEN` — filter to specific context_len
 */
export async function loadOolongTasks(
  options: LoadOptions = {},
): Promise<OolongTask[]> {
  // Fetch if not cached
  if (!existsSync(CACHE_PATH)) {
    await fetchAndCache();
  }

  // Read cache
  const raw = readFileSync(CACHE_PATH, "utf-8");
  const rows: HfRow[] = raw
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as HfRow);

  // Resolve options with env var overrides
  const envMax = process.env.OOLONG_MAX_PER_DATASET;
  const maxPerDataset =
    envMax != null ? Number(envMax) : (options.maxPerDataset ?? 10);

  const envCtxLen = process.env.OOLONG_CONTEXT_LEN;
  const contextLen = envCtxLen != null ? Number(envCtxLen) : options.contextLen;

  // Filter by context_len if specified
  let filtered = rows;
  if (contextLen != null) {
    filtered = filtered.filter((r) => r.context_len === contextLen);
  }

  // Group by source dataset and take up to maxPerDataset from each
  const tasks: OolongTask[] = [];

  if (maxPerDataset > 0 && maxPerDataset < Infinity) {
    const perDataset = new Map<string, number>();
    for (const row of filtered) {
      const count = perDataset.get(row.dataset) ?? 0;
      if (count >= maxPerDataset) continue;
      perDataset.set(row.dataset, count + 1);
      tasks.push(parseRow(row));
    }
  } else {
    for (const row of filtered) {
      tasks.push(parseRow(row));
    }
  }

  if (tasks.length === 0) {
    throw new Error(
      `No Oolong tasks matched filters (contextLen=${contextLen}, maxPerDataset=${maxPerDataset})`,
    );
  }

  return tasks;
}

export type OolongTasksByDataset = Map<string, OolongTask[]>;

/** Module-level cache for the grouped task map. */
let _grouped: OolongTasksByDataset | null = null;

/**
 * Load Oolong tasks grouped by source dataset name.
 *
 * The result is cached at the module level so repeated imports across
 * multiple test files share the same data without re-fetching or
 * re-parsing.
 */
export async function loadOolongTasksByDataset(
  options: LoadOptions = {},
): Promise<OolongTasksByDataset> {
  if (_grouped) return _grouped;

  const tasks = await loadOolongTasks(options);
  const grouped = new Map<string, OolongTask[]>();
  for (const task of tasks) {
    const key = task.dataset;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(task);
  }

  _grouped = grouped;
  return grouped;
}
