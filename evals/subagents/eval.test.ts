import * as ls from "langsmith/vitest";
import { getDefaultRunner } from "@deepagents/evals";
import { defineSubagentsSuite } from "./index.js";

const runner = getDefaultRunner();

ls.describe(
  "deepagents-js-subagents",
  () => {
    defineSubagentsSuite(runner);
  },
  { projectName: runner.name, upsert: true },
);
