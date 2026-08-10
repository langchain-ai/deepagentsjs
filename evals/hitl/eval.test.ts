import * as ls from "langsmith/vitest";
import { getDefaultRunner } from "@deepagents/evals";
import { hitlSuite } from "./index.js";

const runner = getDefaultRunner();

ls.describe(
  "deepagents-js-hitl",
  () => {
    hitlSuite(runner);
  },
  { projectName: runner.name, upsert: true },
);
