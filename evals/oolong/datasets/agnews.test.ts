import * as ls from "langsmith/vitest";
import { getDefaultRunner } from "@deepagents/evals";
import { defineOolongAgnewsSuite, getOolongAgnewsDatasetName, getOolongAgnewsDescribeOptions } from "./agnews.suite.js";

const runner = getDefaultRunner();

ls.describe(
  getOolongAgnewsDatasetName(runner),
  () => {
    defineOolongAgnewsSuite(runner);
  },
  getOolongAgnewsDescribeOptions(runner),
);
