/**
 * OOLONG dataset loader for RLM evals.
 *
 * Fetches the 50 trec_coarse 131K tasks from the HuggingFace datasets
 * server API (oolongbench/oolong-synth, validation split) and caches
 * them locally as tasks.jsonl.
 *
 * Matches the exact same filter logic as rlming's
 * `run_all_benchmarks.py::prepare_tasks()`:
 *   dataset == "trec_coarse" AND context_len == 131072
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";

export interface OolongTask {
  id: string;
  question: string;
  contextWindowText: string;
  answer: string;
  taskType: string;
  contextChars: number;
}

/** Shape of each row from the HuggingFace datasets server API. */
interface HfRow {
  id: number;
  context_len: number;
  dataset: string;
  context_window_text: string;
  question: string;
  task: string;
  answer: string;
  answer_type: string;
  context_window_id: number;
}

/** Shape of the HF datasets server filter response. */
interface HfFilterResponse {
  rows: Array<{ row_idx: number; row: HfRow }>;
  num_rows_total: number;
  num_rows_per_page: number;
}

/** Shape of the cached JSONL record (matches rlming run_all_benchmarks.py). */
interface TaskJsonRecord {
  id: string;
  question: string;
  context_window_text: string;
  metadata: {
    answer: string;
    dataset: string;
    task: string;
    answer_type: string;
    context_window_id: number;
  };
}

const HF_FILTER_URL =
  "https://datasets-server.huggingface.co/filter?" +
  "dataset=oolongbench/oolong-synth&config=default&split=validation&" +
  "where=dataset%3D%27trec_coarse%27%20AND%20context_len%3D131072";

const PAGE_SIZE = 10;

/**
 * Fetch all 50 trec_coarse 131K tasks from HuggingFace and write
 * them to a local JSONL cache file.
 */
async function fetchAndCache(cachePath: string): Promise<void> {
  const dir = dirname(cachePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const records: TaskJsonRecord[] = [];
  let offset = 0;

  // Paginate through results
  while (true) {
    const url = `${HF_FILTER_URL}&offset=${offset}&length=${PAGE_SIZE}`;
    const resp = await fetch(url);
    if (!resp.ok) {
      throw new Error(
        `HuggingFace API error: ${resp.status} ${resp.statusText}`,
      );
    }
    const data = (await resp.json()) as HfFilterResponse;

    for (const { row } of data.rows) {
      let answer = row.answer;
      // Parse list answers (e.g. "['numeric value']") to extract first element
      if (typeof answer === "string" && answer.startsWith("[")) {
        try {
          const parsed = JSON.parse(answer.replace(/'/g, '"'));
          if (Array.isArray(parsed) && parsed.length > 0) {
            answer = String(parsed[0]);
          }
        } catch {
          // keep as-is
        }
      }

      records.push({
        id: String(row.id),
        question: row.question,
        context_window_text: row.context_window_text,
        metadata: {
          answer: String(answer),
          dataset: "trec_coarse",
          task: row.task,
          answer_type: row.answer_type || "",
          context_window_id: row.context_window_id,
        },
      });
    }

    offset += data.rows.length;
    if (data.rows.length < PAGE_SIZE || offset >= data.num_rows_total) {
      break;
    }
  }

  if (records.length === 0) {
    throw new Error("No trec_coarse 131K tasks found in HuggingFace dataset");
  }

  const jsonl = records.map((r) => JSON.stringify(r)).join("\n") + "\n";
  writeFileSync(cachePath, jsonl, "utf-8");
  console.log(
    `Fetched ${records.length} OOLONG tasks from HuggingFace -> ${cachePath}`,
  );
}

/**
 * Load OOLONG tasks. If no local cache exists, fetches from HuggingFace.
 *
 * Cache location (in order of priority):
 * 1. `OOLONG_TASKS_FILE` env var
 * 2. `<repo-root>/oolong-data/tasks.jsonl`
 *
 * @param maxTasks - Optional limit on number of tasks to load.
 */
export async function loadOolongTasks(
  maxTasks?: number,
): Promise<OolongTask[]> {
  const cachePath =
    process.env.OOLONG_TASKS_FILE ||
    resolve(import.meta.dirname, "../../../../../oolong-data/tasks.jsonl");

  // Fetch from HuggingFace if cache doesn't exist
  if (!existsSync(cachePath)) {
    await fetchAndCache(cachePath);
  }

  const raw = readFileSync(cachePath, "utf-8");
  const tasks: OolongTask[] = [];

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const record: TaskJsonRecord = JSON.parse(line);
    tasks.push({
      id: record.id,
      question: record.question,
      contextWindowText: record.context_window_text,
      answer: String(record.metadata.answer).trim(),
      taskType: record.metadata.task || "unknown",
      contextChars: record.context_window_text.length,
    });
    if (maxTasks != null && tasks.length >= maxTasks) break;
  }

  if (tasks.length === 0) {
    throw new Error(`No tasks found in ${cachePath}`);
  }

  return tasks;
}
