import * as ls from "langsmith/vitest";
import { getDefaultRunner } from "@deepagents/evals";
import { defineTodosSuite, getTodosDatasetName, getTodosDescribeOptions } from "./suite.js";

const runner = getDefaultRunner();

ls.describe(
  getTodosDatasetName(runner),
  () => {
    defineTodosSuite(runner);
  },
  getTodosDescribeOptions(runner),
);
