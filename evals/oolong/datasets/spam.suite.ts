import * as ls from "langsmith/vitest";
import type { EvalRunner } from "@deepagents/evals";
import { loadOolongTasksByDataset } from "../load-oolong.js";
import { makeOolongTests } from "../make-tests.js";


const tasks = (await loadOolongTasksByDataset()).get("spam") ?? [];

export function getOolongSpamDatasetName(runner: EvalRunner) {
  return runner.name;
}

export function getOolongSpamDescribeOptions(runner: EvalRunner) {
  return { projectName: "deepagents-js-oolong-spam", upsert: true };
}

export function defineOolongSpamSuite(runner: EvalRunner): void {
      makeOolongTests(tasks);
}
