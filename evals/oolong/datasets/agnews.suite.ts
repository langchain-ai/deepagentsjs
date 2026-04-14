import * as ls from "langsmith/vitest";
import type { EvalRunner } from "@deepagents/evals";
import { loadOolongTasksByDataset } from "../load-oolong.js";
import { makeOolongTests } from "../make-tests.js";


const tasks = (await loadOolongTasksByDataset()).get("agnews") ?? [];

export function getOolongAgnewsDatasetName(runner: EvalRunner) {
  return runner.name;
}

export function getOolongAgnewsDescribeOptions(runner: EvalRunner) {
  return { projectName: "deepagents-js-oolong-agnews", upsert: true };
}

export function defineOolongAgnewsSuite(runner: EvalRunner): void {
      makeOolongTests(tasks);
}
