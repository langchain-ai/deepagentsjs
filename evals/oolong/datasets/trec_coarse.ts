import * as ls from "langsmith/vitest";
import type { EvalRunner } from "@deepagents/evals";
import { loadOolongTasksByDataset } from "../load-oolong.js";
import { makeOolongTests } from "../make-tests.js";


const tasks = (await loadOolongTasksByDataset()).get("trec_coarse") ?? [];

export function oolongTrecCoarseSuite(runner: EvalRunner): void {
      makeOolongTests(tasks);
}
