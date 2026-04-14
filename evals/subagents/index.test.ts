import * as ls from "langsmith/vitest";
import { getDefaultRunner } from "@deepagents/evals";
import { defineSubagentsSuite, getSubagentsDatasetName, getSubagentsDescribeOptions } from "./suite.js";

const runner = getDefaultRunner();

ls.describe(
  getSubagentsDatasetName(runner),
  () => {
    defineSubagentsSuite(runner);
  },
  getSubagentsDescribeOptions(runner),
);
