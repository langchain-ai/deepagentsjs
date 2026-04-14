import * as ls from "langsmith/vitest";
import { getDefaultRunner } from "@deepagents/evals";
import { defineHitlSuite } from "./index.js";

const runner = getDefaultRunner();

ls.describe(
  "deepagents-js-hitl",
  () => {
    defineHitlSuite(runner);
  },
  { projectName: runner.name, upsert: true },
);
