import * as ls from "langsmith/vitest";
import { getDefaultRunner } from "@deepagents/evals";
import { basicSuite } from "./index.js";

const runner = getDefaultRunner();

ls.describe(
  "deepagents-js-basic",
  () => {
    basicSuite(runner);
  },
  { projectName: runner.name, upsert: true },
);
