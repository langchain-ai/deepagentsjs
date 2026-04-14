import * as ls from "langsmith/vitest";
import { getDefaultRunner } from "@deepagents/evals";
import { defineToolUsageRelationalSuite, getToolUsageRelationalDatasetName, getToolUsageRelationalDescribeOptions } from "./suite.js";

const runner = getDefaultRunner();

ls.describe(
  getToolUsageRelationalDatasetName(runner),
  () => {
    defineToolUsageRelationalSuite(runner);
  },
  getToolUsageRelationalDescribeOptions(runner),
);
