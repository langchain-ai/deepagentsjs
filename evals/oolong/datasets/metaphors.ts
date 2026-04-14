import type { EvalRunner } from "@deepagents/evals";
import { loadOolongTasksByDataset } from "../load-oolong.js";
import { makeOolongTests } from "../make-tests.js";

const tasks = (await loadOolongTasksByDataset()).get("metaphors") ?? [];

export function oolongMetaphorsSuite(runner: EvalRunner): void {
  makeOolongTests(tasks);
}
