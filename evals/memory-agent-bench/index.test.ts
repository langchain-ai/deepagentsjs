import * as ls from "langsmith/vitest";
import { getDefaultRunner } from "@deepagents/evals";
import { defineMemoryAgentBenchSuite, getMemoryAgentBenchDatasetName, getMemoryAgentBenchDescribeOptions } from "./suite.js";

const runner = getDefaultRunner();

ls.describe(
  getMemoryAgentBenchDatasetName(runner),
  () => {
    defineMemoryAgentBenchSuite(runner);
  },
  getMemoryAgentBenchDescribeOptions(runner),
);
