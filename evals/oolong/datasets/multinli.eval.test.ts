import * as ls from "langsmith/vitest";
import { getDefaultRunner } from "@deepagents/evals";
import { oolongMultinliSuite } from "./multinli.js";

const runner = getDefaultRunner();

ls.describe(
  runner.name,
  () => {
    oolongMultinliSuite(runner);
  },
  { projectName: "deepagents-js-oolong-multinli", upsert: true },
);
