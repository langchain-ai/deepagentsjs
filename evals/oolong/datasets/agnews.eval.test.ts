import * as ls from "langsmith/vitest";
import { getDefaultRunner } from "@deepagents/evals";
import { defineOolongAgnewsSuite } from "./agnews.js";

const runner = getDefaultRunner();

ls.describe(
  runner.name,
  () => {
    defineOolongAgnewsSuite(runner);
  },
  { projectName: "deepagents-js-oolong-agnews", upsert: true },
);
