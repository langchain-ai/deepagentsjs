import * as ls from "langsmith/vitest";
import { getDefaultRunner } from "@deepagents/evals";
import { defineFilesSuite, getFilesDatasetName, getFilesDescribeOptions } from "./suite.js";

const runner = getDefaultRunner();

ls.describe(
  getFilesDatasetName(runner),
  () => {
    defineFilesSuite(runner);
  },
  getFilesDescribeOptions(runner),
);
