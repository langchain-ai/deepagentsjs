import * as ls from "langsmith/vitest";
import { getDefaultRunner } from "@deepagents/evals";
import { defineTau2AirlineSuite, getTau2AirlineDatasetName, getTau2AirlineDescribeOptions } from "./suite.js";

const runner = getDefaultRunner();

ls.describe(
  getTau2AirlineDatasetName(runner),
  () => {
    defineTau2AirlineSuite(runner);
  },
  getTau2AirlineDescribeOptions(runner),
);
