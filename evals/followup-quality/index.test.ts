import * as ls from "langsmith/vitest";
import { getDefaultRunner } from "@deepagents/evals";
import { defineFollowupQualitySuite, getFollowupQualityDatasetName, getFollowupQualityDescribeOptions } from "./suite.js";

const runner = getDefaultRunner();

ls.describe(
  getFollowupQualityDatasetName(runner),
  () => {
    defineFollowupQualitySuite(runner);
  },
  getFollowupQualityDescribeOptions(runner),
);
