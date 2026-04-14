import * as ls from "langsmith/vitest";
import { getDefaultRunner } from "@deepagents/evals";
import { defineMemoryMultiturnSuite } from "./index.js";

const runner = getDefaultRunner();

ls.describe(
  "deepagents-js-memory-multiturn",
  () => {
    defineMemoryMultiturnSuite(runner);
  },
  { projectName: runner.name, upsert: true },
);
