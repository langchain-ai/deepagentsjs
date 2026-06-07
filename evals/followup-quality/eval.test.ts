import * as ls from "langsmith/vitest";
import { getDefaultRunner } from "@deepagents/evals";
import { followupQualitySuite } from "./index.js";

const runner = getDefaultRunner();

ls.describe(
  "deepagents-js-followup-quality",
  () => {
    followupQualitySuite(runner);
  },
  { projectName: runner.name, upsert: true },
);
