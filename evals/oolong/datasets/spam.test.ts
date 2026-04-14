import * as ls from "langsmith/vitest";
import { getDefaultRunner } from "@deepagents/evals";
import { defineOolongSpamSuite, getOolongSpamDatasetName, getOolongSpamDescribeOptions } from "./spam.suite.js";

const runner = getDefaultRunner();

ls.describe(
  getOolongSpamDatasetName(runner),
  () => {
    defineOolongSpamSuite(runner);
  },
  getOolongSpamDescribeOptions(runner),
);
