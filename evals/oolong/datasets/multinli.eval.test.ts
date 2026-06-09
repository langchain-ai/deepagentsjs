import { getDefaultRunner } from "@deepagents/evals";
import * as ls from "langsmith/vitest";
import { oolongMultinliSuite } from "./multinli.js";

const runner = getDefaultRunner();

ls.describe(
  runner.name,
  () => {
    oolongMultinliSuite(runner);
  },
  { projectName: "deepagents-js-oolong-multinli", upsert: true },
);
