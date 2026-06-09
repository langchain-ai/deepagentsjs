/**
 * Oolong dataset loader.
 *
 * Reads tasks from Hugging Face auto-converted Parquet files via DuckDB's
 * `hf://` protocol and caches results locally as JSONL in `.cache/`.
 *
 * To avoid downloading huge context columns unnecessarily, loading is done in
 * two passes:
 * 1. query metadata columns only (with optional `context_len` filter)
 * 2. fetch `context_window_text` only for selected IDs
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";

export interface OolongTask {
  /** Unique row ID from the dataset. */
  id: number;
  /** Source dataset name (e.g. "spam", "trec_coarse"). */
  dataset: string;
  /** Context length bucket. */
  contextLen: number;
  /** The full context text the agent must reason over. */
  contextWindowText: string;
  /** The aggregation question to answer. */
  question: string;
  /** Task group (e.g. "counting", "user", "temporal"). */
  taskGroup: string;
  /** Specific task type (e.g. "TASK_TYPE.MOST_FREQ"). */
  task: string;
  /** Gold answer (may be JSON-encoded list). */
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

interface OolongMetadataRow {
  id: bigint | number | string;
  context_len: bigint | number | string;
  dataset: string;
  question: string;
  task_group: string;
  task: string;
  answer: string;
  answer_type: string;
  input_subset: boolean | string | number | null;
  num_labels: bigint | number | string;
  context_window_id: bigint | number | string;
}

interface OolongContextRow {
  id: bigint | number | string;
  context_window_text: string;
}

const CACHE_DIR = join(import.meta.dirname, ".cache");
const CACHE_PATH = join(CACHE_DIR, "tasks.jsonl");
const PARQUET_GLOB =
  "hf://datasets/oolongbench/oolong-synth@~parquet/default/partial-validation/*.parquet";

function getCachePath(contextLen?: number): string {
  if (contextLen == null) {
    return CACHE_PATH;
  }
  return join(CACHE_DIR, `tasks.context_len_${contextLen}.jsonl`);
}

function toNumber(value: bigint | number | string, fieldName: string): number {
  if (typeof value === "bigint") {
    return Number(value);
  }
  if (typeof value === "number") {
    return value;
  }
  const parsed = Number(value);
  if (Number.isNaN(parsed)) {
    throw new Error(`Unexpected non-numeric ${fieldName}: ${String(value)}`);
  }
  return parsed;
}

function toBoolean(
  value: boolean | string | number | null,
  fieldName: string,
): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value !== 0;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    return normalized === "true" || normalized === "1";
  }
  if (value == null) {
    return false;
  }
  throw new Error(`Unexpected non-boolean ${fieldName}: ${String(value)}`);
}

function normalizeContextLen(value: unknown): number | undefined {
  if (value == null) return undefined;
  const parsed =
    typeof value === "number" ? value : Number.parseInt(String(value), 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`Invalid OOLONG_CONTEXT_LEN value: ${String(value)}`);
  }
  return parsed;
}

function quoteSqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function buildMetadataQuery(contextLen?: number): string {
  const whereClause =
    contextLen != null ? `WHERE context_len = ${contextLen}` : "";
  return `
    SELECT
      id,
      context_len,
      dataset,
      question,
      task_group,
      task,
      answer,
      answer_type,
      input_subset,
      num_labels,
      context_window_id
    FROM ${quoteSqlString(PARQUET_GLOB)}
    ${whereClause}
    ORDER BY id
  `;
}

function buildContextQuery(ids: number[]): string {
  if (ids.length === 0) {
    throw new Error("Cannot build context query for empty id list");
  }
  return `
    SELECT
      id,
      context_window_text
    FROM ${quoteSqlString(PARQUET_GLOB)}
    WHERE id IN (${ids.join(", ")})
    ORDER BY id
  `;
}

async function runQuery<T extends object>(sql: string): Promise<T[]> {
  const instance = await DuckDBInstance.create();
  const connection = await instance.connect();
  try {
    const reader = await connection.runAndReadAll(sql);
    return reader.getRowObjects() as T[];
  } finally {
    connection.disconnectSync();
  }
}

async function fetchTasks(contextLen?: number): Promise<OolongTask[]> {
  const metadataRows = await runQuery<OolongMetadataRow>(
    buildMetadataQuery(contextLen),
  );

  if (metadataRows.length === 0) {
    return [];
  }

  const ids = metadataRows.map((row) => toNumber(row.id, "id"));
  const contextRows = await runQuery<OolongContextRow>(buildContextQuery(ids));
  const contextById = new Map<number, string>();
  for (const row of contextRows) {
    contextById.set(
      toNumber(row.id, "id"),
      String(row.context_window_text ?? ""),
    );
  }

  return metadataRows.map((row) => {
    const id = toNumber(row.id, "id");
    const contextWindowText = contextById.get(id);
    if (contextWindowText == null) {
      throw new Error(`Missing context_window_text for id=${id}`);
    }
    return {
      id,
      dataset: String(row.dataset),
      contextLen: toNumber(row.context_len, "context_len"),
      contextWindowText,
      question: String(row.question),
      taskGroup: String(row.task_group),
      task: String(row.task),
      answer: String(row.answer),
      answerType: String(row.answer_type),
      inputSubset: toBoolean(row.input_subset, "input_subset"),
      numLabels: toNumber(row.num_labels, "num_labels"),
      contextWindowId: toNumber(row.context_window_id, "context_window_id"),
    };
  });
}

async function fetchAndCache(contextLen?: number): Promise<void> {
  mkdirSync(CACHE_DIR, { recursive: true });
  const cachePath = getCachePath(contextLen);

  // oxlint-disable-next-line no-console
  console.log(
    `Fetching Oolong tasks via DuckDB${contextLen != null ? ` (context_len=${contextLen})` : ""}...`,
  );

  const tasks = await fetchTasks(contextLen);

  if (tasks.length === 0) {
    throw new Error(
      contextLen != null
        ? `No rows found in oolongbench/oolong-synth for context_len=${contextLen}.`
        : "No rows found in oolongbench/oolong-synth.",
    );
  }

  const jsonl = tasks.map((task) => JSON.stringify(task)).join("\n") + "\n";
  writeFileSync(cachePath, jsonl, "utf-8");

  // oxlint-disable-next-line no-console
  console.log(`Cached ${tasks.length} Oolong tasks -> ${cachePath}`);
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
 * Load Oolong tasks from local cache (fetching via DuckDB on cache miss).
 *
 * Environment variable overrides:
 * - `OOLONG_MAX_PER_DATASET` — override maxPerDataset
 * - `OOLONG_CONTEXT_LEN` — filter to specific context_len
 */
export async function loadOolongTasks(
  options: LoadOptions = {},
): Promise<OolongTask[]> {
  const envMax = process.env.OOLONG_MAX_PER_DATASET;
  const maxPerDataset =
    envMax != null ? Number(envMax) : (options.maxPerDataset ?? 10);

  const contextLen = normalizeContextLen(
    process.env.OOLONG_CONTEXT_LEN ?? options.contextLen,
  );

  const cachePath = getCachePath(contextLen);
  if (!existsSync(cachePath)) {
    await fetchAndCache(contextLen);
  }

  const raw = readFileSync(cachePath, "utf-8");
  const tasks: OolongTask[] = raw.trim()
    ? raw
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line) as OolongTask)
    : [];

  if (tasks.length === 0) {
    throw new Error(
      `No Oolong tasks found in cache (contextLen=${contextLen ?? "all"}).`,
    );
  }

  if (maxPerDataset > 0 && maxPerDataset < Infinity) {
    const selected: OolongTask[] = [];
    const perDataset = new Map<string, number>();
    for (const task of tasks) {
      const count = perDataset.get(task.dataset) ?? 0;
      if (count >= maxPerDataset) continue;
      perDataset.set(task.dataset, count + 1);
      selected.push(task);
    }
    if (selected.length === 0) {
      throw new Error(
        `No Oolong tasks matched maxPerDataset=${maxPerDataset} (contextLen=${contextLen ?? "all"}).`,
      );
    }
    return selected;
  }

  return tasks;
}

export type OolongTasksByDataset = Map<string, OolongTask[]>;

/** Module-level cache for grouped task maps by options/env key. */
const _groupedByKey = new Map<string, OolongTasksByDataset>();

/**
 * Load Oolong tasks grouped by source dataset name.
 */
export async function loadOolongTasksByDataset(
  options: LoadOptions = {},
): Promise<OolongTasksByDataset> {
  const key = JSON.stringify({
    maxPerDataset: process.env.OOLONG_MAX_PER_DATASET ?? options.maxPerDataset,
    contextLen: process.env.OOLONG_CONTEXT_LEN ?? options.contextLen ?? null,
  });

  const cached = _groupedByKey.get(key);
  if (cached) return cached;

  const tasks = await loadOolongTasks(options);
  const grouped = new Map<string, OolongTask[]>();
  for (const task of tasks) {
    if (!grouped.has(task.dataset)) grouped.set(task.dataset, []);
    grouped.get(task.dataset)!.push(task);
  }

  _groupedByKey.set(key, grouped);
  return grouped;
}
