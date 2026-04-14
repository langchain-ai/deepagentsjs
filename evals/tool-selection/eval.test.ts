import * as ls from "langsmith/vitest";
import { getDefaultRunner } from "@deepagents/evals";
import { defineToolSelectionSuite } from "./index.js";

const runner = getDefaultRunner();

ls.describe(
  "deepagents-js-tool-selection",
  () => {
    defineToolSelectionSuite(runner);
  },
  { projectName: runner.name, upsert: true },
);
