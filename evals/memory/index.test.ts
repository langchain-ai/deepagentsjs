import * as ls from "langsmith/vitest";
import { getDefaultRunner } from "@deepagents/evals";
import { defineMemorySuite, getMemoryDatasetName, getMemoryDescribeOptions } from "./suite.js";

const runner = getDefaultRunner();

ls.describe(
  getMemoryDatasetName(runner),
  () => {
    defineMemorySuite(runner);
  },
  getMemoryDescribeOptions(runner),
);
