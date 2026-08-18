import * as ls from "langsmith/vitest";
import { getDefaultRunner } from "@deepagents/evals";
import { subagentForkingSuite } from "./index.js";

const runner = getDefaultRunner();

ls.describe(
  "deepagents-js-subagent-forking",
  () => {
    subagentForkingSuite(runner);
  },
  { projectName: runner.name, upsert: true },
);
