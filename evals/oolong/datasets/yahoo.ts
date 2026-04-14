import * as ls from "langsmith/vitest";
import type { EvalRunner } from "@deepagents/evals";
import { loadOolongTasksByDataset } from "../load-oolong.js";
import { makeOolongTests } from "../make-tests.js";


const tasks = (await loadOolongTasksByDataset()).get("yahoo") ?? [];

export function defineOolongYahooSuite(runner: EvalRunner): void {
      makeOolongTests(tasks);
}
