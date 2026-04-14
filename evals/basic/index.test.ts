import * as ls from "langsmith/vitest";
import { getDefaultRunner } from "@deepagents/evals";
import { defineBasicSuite, getBasicDatasetName, getBasicDescribeOptions } from "./suite.js";

const runner = getDefaultRunner();

ls.describe(
  getBasicDatasetName(runner),
  () => {
    defineBasicSuite(runner);
  },
  getBasicDescribeOptions(runner),
);
