import * as ls from "langsmith/vitest";
import type { EvalRunner } from "@deepagents/evals";
import { loadOolongTasksByDataset } from "../load-oolong.js";
import { makeOolongTests } from "../make-tests.js";


const tasks = (await loadOolongTasksByDataset()).get("imdb") ?? [];

export function getOolongImdbDatasetName(runner: EvalRunner) {
  return runner.name;
}

export function getOolongImdbDescribeOptions(runner: EvalRunner) {
  return { projectName: "deepagents-js-oolong-imdb", upsert: true };
}

export function defineOolongImdbSuite(runner: EvalRunner): void {
      makeOolongTests(tasks);
}
