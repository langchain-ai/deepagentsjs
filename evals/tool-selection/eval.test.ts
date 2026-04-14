import * as ls from "langsmith/vitest";
import { getDefaultRunner } from "@deepagents/evals";
import { toolSelectionSuite } from "./index.js";

const runner = getDefaultRunner();

ls.describe(
  "deepagents-js-tool-selection",
  () => {
    toolSelectionSuite(runner);
  },
  { projectName: runner.name, upsert: true },
);
