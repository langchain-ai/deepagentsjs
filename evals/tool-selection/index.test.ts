import * as ls from "langsmith/vitest";
import { getDefaultRunner } from "@deepagents/evals";
import { defineToolSelectionSuite, getToolSelectionDatasetName, getToolSelectionDescribeOptions } from "./suite.js";

const runner = getDefaultRunner();

ls.describe(
  getToolSelectionDatasetName(runner),
  () => {
    defineToolSelectionSuite(runner);
  },
  getToolSelectionDescribeOptions(runner),
);
