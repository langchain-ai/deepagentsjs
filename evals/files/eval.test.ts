import * as ls from "langsmith/vitest";
import { getDefaultRunner } from "@deepagents/evals";
import { defineFilesSuite } from "./index.js";

const runner = getDefaultRunner();

ls.describe(
  "deepagents-js-files",
  () => {
    defineFilesSuite(runner);
  },
  { projectName: runner.name, upsert: true },
);
