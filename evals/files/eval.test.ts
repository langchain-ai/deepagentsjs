import * as ls from "langsmith/vitest";
import { getDefaultRunner } from "@deepagents/evals";
import { filesSuite } from "./index.js";

const runner = getDefaultRunner();

ls.describe(
  "deepagents-js-files",
  () => {
    filesSuite(runner);
  },
  { projectName: runner.name, upsert: true },
);
