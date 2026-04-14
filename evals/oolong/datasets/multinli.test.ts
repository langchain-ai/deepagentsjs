import * as ls from "langsmith/vitest";
import { getDefaultRunner } from "@deepagents/evals";
import { defineOolongMultinliSuite, getOolongMultinliDatasetName, getOolongMultinliDescribeOptions } from "./multinli.suite.js";

const runner = getDefaultRunner();

ls.describe(
  getOolongMultinliDatasetName(runner),
  () => {
    defineOolongMultinliSuite(runner);
  },
  getOolongMultinliDescribeOptions(runner),
);
