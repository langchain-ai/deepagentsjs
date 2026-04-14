import * as ls from "langsmith/vitest";
import type { EvalRunner } from "@deepagents/evals";
import { loadOolongTasksByDataset } from "../load-oolong.js";
import { makeOolongTests } from "../make-tests.js";


const tasks = (await loadOolongTasksByDataset()).get("yahoo") ?? [];

export function getOolongYahooDatasetName(runner: EvalRunner) {
  return runner.name;
}

export function getOolongYahooDescribeOptions(runner: EvalRunner) {
  return { projectName: "deepagents-js-oolong-yahoo", upsert: true };
}

export function defineOolongYahooSuite(runner: EvalRunner): void {
      makeOolongTests(tasks);
}
