import * as ls from "langsmith/vitest";
import { getDefaultRunner } from "@deepagents/evals";
import { subagentsSuite } from "./index.js";

const runner = getDefaultRunner();

ls.describe(
  "deepagents-js-subagents",
  () => {
    subagentsSuite(runner);
  },
  { projectName: runner.name, upsert: true },
);
