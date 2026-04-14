import * as ls from "langsmith/vitest";
import { getDefaultRunner } from "@deepagents/evals";
import { defineOolongNegationSuite, getOolongNegationDatasetName, getOolongNegationDescribeOptions } from "./negation.suite.js";

const runner = getDefaultRunner();

ls.describe(
  getOolongNegationDatasetName(runner),
  () => {
    defineOolongNegationSuite(runner);
  },
  getOolongNegationDescribeOptions(runner),
);
