import * as ls from "langsmith/vitest";
import { getDefaultRunner } from "@deepagents/evals";
import { defineToolUsageRelationalSuite } from "./index.js";

const runner = getDefaultRunner();

ls.describe(
  "deepagents-js-tool-usage-relational",
  () => {
    defineToolUsageRelationalSuite(runner);
  },
  { projectName: runner.name, upsert: true },
);
