import * as ls from "langsmith/vitest";
import { getDefaultRunner } from "@deepagents/evals";
import { defineSummarizationSuite, getSummarizationDatasetName, getSummarizationDescribeOptions } from "./suite.js";

const runner = getDefaultRunner();

ls.describe(
  getSummarizationDatasetName(runner),
  () => {
    defineSummarizationSuite(runner);
  },
  getSummarizationDescribeOptions(runner),
);
