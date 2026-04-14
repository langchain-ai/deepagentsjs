import * as ls from "langsmith/vitest";
import type { EvalRunner } from "@deepagents/evals";
import { loadOolongTasksByDataset } from "../load-oolong.js";
import { makeOolongTests } from "../make-tests.js";


const tasks = (await loadOolongTasksByDataset()).get("metaphors") ?? [];

export function getOolongMetaphorsDatasetName(runner: EvalRunner) {
  return runner.name;
}

export function getOolongMetaphorsDescribeOptions(runner: EvalRunner) {
  return { projectName: "deepagents-js-oolong-metaphors", upsert: true };
}

export function defineOolongMetaphorsSuite(runner: EvalRunner): void {
      makeOolongTests(tasks);
}
