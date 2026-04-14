import * as ls from "langsmith/vitest";
import { getDefaultRunner } from "@deepagents/evals";
import { defineOolongAppReviewsSuite, getOolongAppReviewsDatasetName, getOolongAppReviewsDescribeOptions } from "./app_reviews.suite.js";

const runner = getDefaultRunner();

ls.describe(
  getOolongAppReviewsDatasetName(runner),
  () => {
    defineOolongAppReviewsSuite(runner);
  },
  getOolongAppReviewsDescribeOptions(runner),
);
