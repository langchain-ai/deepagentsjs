import { getDefaultRunner } from "@deepagents/evals";
import * as ls from "langsmith/vitest";
import { oolongAgnewsSuite } from "./agnews.js";

const runner = getDefaultRunner();

ls.describe(
  runner.name,
  () => {
    oolongAgnewsSuite(runner);
  },
  { projectName: "deepagents-js-oolong-agnews", upsert: true },
);
