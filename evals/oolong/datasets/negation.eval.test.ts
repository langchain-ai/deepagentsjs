import * as ls from "langsmith/vitest";
import { oolongNegationSuite } from "./negation.js";

ls.describe(
  "deepagents-js-oolong-negation",
  () => {
    oolongNegationSuite();
  },
  { projectName: "negation-baseline", upsert: true },
);
