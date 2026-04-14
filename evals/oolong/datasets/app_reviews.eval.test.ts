import * as ls from "langsmith/vitest";
import { getDefaultRunner } from "@deepagents/evals";
import { defineOolongAppReviewsSuite } from "./app_reviews.js";

const runner = getDefaultRunner();

ls.describe(
  runner.name,
  () => {
    defineOolongAppReviewsSuite(runner);
  },
  { projectName: "deepagents-js-oolong-app-reviews", upsert: true },
);
