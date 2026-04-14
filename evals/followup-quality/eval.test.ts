import * as ls from "langsmith/vitest";
import { getDefaultRunner } from "@deepagents/evals";
import { defineFollowupQualitySuite } from "./index.js";

const runner = getDefaultRunner();

ls.describe(
  "deepagents-js-followup-quality",
  () => {
    defineFollowupQualitySuite(runner);
  },
  { projectName: runner.name, upsert: true },
);
