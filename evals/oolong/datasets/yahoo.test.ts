import * as ls from "langsmith/vitest";
import { getDefaultRunner } from "@deepagents/evals";
import { defineOolongYahooSuite, getOolongYahooDatasetName, getOolongYahooDescribeOptions } from "./yahoo.suite.js";

const runner = getDefaultRunner();

ls.describe(
  getOolongYahooDatasetName(runner),
  () => {
    defineOolongYahooSuite(runner);
  },
  getOolongYahooDescribeOptions(runner),
);
