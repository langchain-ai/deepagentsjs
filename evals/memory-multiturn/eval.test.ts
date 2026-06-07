import * as ls from "langsmith/vitest";
import { getDefaultRunner } from "@deepagents/evals";
import { memoryMultiturnSuite } from "./index.js";

const runner = getDefaultRunner();

ls.describe(
  "deepagents-js-memory-multiturn",
  () => {
    memoryMultiturnSuite(runner);
  },
  { projectName: runner.name, upsert: true },
);
