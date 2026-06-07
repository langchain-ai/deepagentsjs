import * as ls from "langsmith/vitest";
import { getDefaultRunner } from "@deepagents/evals";
import { memoryAgentBenchSuite } from "./index.js";

const runner = getDefaultRunner();

ls.describe(
  "deepagents-js-memory-agent-bench",
  () => {
    memoryAgentBenchSuite(runner);
  },
  { projectName: runner.name, upsert: true },
);
