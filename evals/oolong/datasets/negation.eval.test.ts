import * as ls from "langsmith/vitest";
import { getDefaultRunner } from "@deepagents/evals";
import { defineOolongNegationSuite } from "./negation.js";

const runner = getDefaultRunner();

ls.describe(
  runner.name,
  () => {
    defineOolongNegationSuite(runner);
  },
  { projectName: "deepagents-js-oolong-negation", upsert: true },
);
