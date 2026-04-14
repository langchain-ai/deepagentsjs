import * as ls from "langsmith/vitest";
import { getDefaultRunner } from "@deepagents/evals";
import { summarizationSuite } from "./index.js";

const runner = getDefaultRunner();

ls.describe(
  "deepagents-js-summarization",
  () => {
    summarizationSuite(runner);
  },
  { projectName: runner.name, upsert: true },
);
