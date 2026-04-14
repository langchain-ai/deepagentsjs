import * as ls from "langsmith/vitest";
import { getDefaultRunner } from "@deepagents/evals";
import { toolUsageRelationalSuite } from "./index.js";

const runner = getDefaultRunner();

ls.describe(
  "deepagents-js-tool-usage-relational",
  () => {
    toolUsageRelationalSuite(runner);
  },
  { projectName: runner.name, upsert: true },
);
