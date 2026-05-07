import * as ls from "langsmith/vitest";
import { oolongAppReviewsSuite } from "./app_reviews.js";

ls.describe(
  "deepagents-js-oolong-app-reviews",
  () => {
    oolongAppReviewsSuite();
  },
  { projectName: "app-reviews-baseline", upsert: true },
);
