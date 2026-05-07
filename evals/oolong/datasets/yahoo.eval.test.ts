import * as ls from "langsmith/vitest";
import { oolongYahooSuite } from "./yahoo.js";

ls.describe(
  "deepagents-js-oolong-yahoo",
  () => {
    oolongYahooSuite();
  },
  { projectName: "yahoo-baseline", upsert: true },
);
