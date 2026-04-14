import * as ls from "langsmith/vitest";
import { getDefaultRunner } from "@deepagents/evals";
import { defineMemoryMultiturnSuite, getMemoryMultiturnDatasetName, getMemoryMultiturnDescribeOptions } from "./suite.js";

const runner = getDefaultRunner();

ls.describe(
  getMemoryMultiturnDatasetName(runner),
  () => {
    defineMemoryMultiturnSuite(runner);
  },
  getMemoryMultiturnDescribeOptions(runner),
);
