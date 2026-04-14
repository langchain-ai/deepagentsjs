import * as ls from "langsmith/vitest";
import type { EvalRunner } from "@deepagents/evals";
import { loadOolongTasksByDataset } from "../load-oolong.js";
import { makeOolongTests } from "../make-tests.js";


const tasks = (await loadOolongTasksByDataset()).get("negation") ?? [];

export function getOolongNegationDatasetName(runner: EvalRunner) {
  return runner.name;
}

export function getOolongNegationDescribeOptions(runner: EvalRunner) {
  return { projectName: "deepagents-js-oolong-negation", upsert: true };
}

export function defineOolongNegationSuite(runner: EvalRunner): void {
      makeOolongTests(tasks);
}
