import * as ls from "langsmith/vitest";
import type { EvalRunner } from "@deepagents/evals";
import { loadOolongTasksByDataset } from "../load-oolong.js";
import { makeOolongTests } from "../make-tests.js";


const tasks = (await loadOolongTasksByDataset()).get("formality") ?? [];

export function getOolongFormalityDatasetName(runner: EvalRunner) {
  return runner.name;
}

export function getOolongFormalityDescribeOptions(runner: EvalRunner) {
  return { projectName: "deepagents-js-oolong-formality", upsert: true };
}

export function defineOolongFormalitySuite(runner: EvalRunner): void {
      makeOolongTests(tasks);
}
