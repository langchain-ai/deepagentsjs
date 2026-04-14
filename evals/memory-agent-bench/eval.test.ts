import * as ls from "langsmith/vitest";
import { getDefaultRunner } from "@deepagents/evals";
import { defineMemoryAgentBenchSuite } from "./index.js";

const runner = getDefaultRunner();

ls.describe(
  "deepagents-js-memory-agent-bench",
  () => {
    defineMemoryAgentBenchSuite(runner);
  },
  { projectName: runner.name, upsert: true },
);
