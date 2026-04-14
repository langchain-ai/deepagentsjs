import * as ls from "langsmith/vitest";
import { getDefaultRunner } from "@deepagents/evals";
import { oolongNegationSuite } from "./negation.js";

const runner = getDefaultRunner();

ls.describe(
  runner.name,
  () => {
    oolongNegationSuite(runner);
  },
  { projectName: "deepagents-js-oolong-negation", upsert: true },
);
