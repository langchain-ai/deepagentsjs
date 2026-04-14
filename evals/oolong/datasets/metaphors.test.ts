import * as ls from "langsmith/vitest";
import { getDefaultRunner } from "@deepagents/evals";
import { defineOolongMetaphorsSuite, getOolongMetaphorsDatasetName, getOolongMetaphorsDescribeOptions } from "./metaphors.suite.js";

const runner = getDefaultRunner();

ls.describe(
  getOolongMetaphorsDatasetName(runner),
  () => {
    defineOolongMetaphorsSuite(runner);
  },
  getOolongMetaphorsDescribeOptions(runner),
);
