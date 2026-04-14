import * as ls from "langsmith/vitest";
import { getDefaultRunner } from "@deepagents/evals";
import { oolongYahooSuite } from "./yahoo.js";

const runner = getDefaultRunner();

ls.describe(
  runner.name,
  () => {
    oolongYahooSuite(runner);
  },
  { projectName: "deepagents-js-oolong-yahoo", upsert: true },
);
