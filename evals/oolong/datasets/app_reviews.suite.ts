import * as ls from "langsmith/vitest";
import type { EvalRunner } from "@deepagents/evals";
import { loadOolongTasksByDataset } from "../load-oolong.js";
import { makeOolongTests } from "../make-tests.js";


const tasks = (await loadOolongTasksByDataset()).get("app_reviews") ?? [];

export function getOolongAppReviewsDatasetName(runner: EvalRunner) {
  return runner.name;
}

export function getOolongAppReviewsDescribeOptions(runner: EvalRunner) {
  return { projectName: "deepagents-js-oolong-app-reviews", upsert: true };
}

export function defineOolongAppReviewsSuite(runner: EvalRunner): void {
      makeOolongTests(tasks);
}
