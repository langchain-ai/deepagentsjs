import * as ls from "langsmith/vitest";
import { getDefaultRunner } from "@deepagents/evals";
import { defineExternalBenchmarksSuite, getExternalBenchmarksDatasetName, getExternalBenchmarksDescribeOptions } from "./suite.js";

const runner = getDefaultRunner();

ls.describe(
  getExternalBenchmarksDatasetName(runner),
  () => {
    defineExternalBenchmarksSuite(runner);
  },
  getExternalBenchmarksDescribeOptions(runner),
);
