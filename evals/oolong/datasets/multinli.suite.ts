import * as ls from "langsmith/vitest";
import type { EvalRunner } from "@deepagents/evals";
import { loadOolongTasksByDataset } from "../load-oolong.js";
import { makeOolongTests } from "../make-tests.js";


const tasks = (await loadOolongTasksByDataset()).get("multinli") ?? [];

export function getOolongMultinliDatasetName(runner: EvalRunner) {
  return runner.name;
}

export function getOolongMultinliDescribeOptions(runner: EvalRunner) {
  return { projectName: "deepagents-js-oolong-multinli", upsert: true };
}

export function defineOolongMultinliSuite(runner: EvalRunner): void {
      makeOolongTests(tasks);
}
