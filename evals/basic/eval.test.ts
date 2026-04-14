import * as ls from "langsmith/vitest";
import { getDefaultRunner } from "@deepagents/evals";
import { defineBasicSuite } from "./index.js";

const runner = getDefaultRunner();

ls.describe(
  "deepagents-js-basic",
  () => {
    defineBasicSuite(runner);
  },
  { projectName: runner.name, upsert: true },
);
