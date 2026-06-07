import type { EvalRunner } from "@deepagents/evals";
import { loadOolongTasksByDataset } from "../load-oolong.js";
import { makeOolongTests } from "../make-tests.js";

const tasks = (await loadOolongTasksByDataset()).get("negation") ?? [];

export function oolongNegationSuite(runner: EvalRunner): void {
  makeOolongTests(tasks);
}
