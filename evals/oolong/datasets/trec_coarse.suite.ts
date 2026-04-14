import * as ls from "langsmith/vitest";
import type { EvalRunner } from "@deepagents/evals";
import { loadOolongTasksByDataset } from "../load-oolong.js";
import { makeOolongTests } from "../make-tests.js";


const tasks = (await loadOolongTasksByDataset()).get("trec_coarse") ?? [];

export function getOolongTrecCoarseDatasetName(runner: EvalRunner) {
  return runner.name;
}

export function getOolongTrecCoarseDescribeOptions(runner: EvalRunner) {
  return { projectName: "deepagents-js-oolong-trec-coarse", upsert: true };
}

export function defineOolongTrecCoarseSuite(runner: EvalRunner): void {
      makeOolongTests(tasks);
}
