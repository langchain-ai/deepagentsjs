import * as ls from "langsmith/vitest";
import { getDefaultRunner } from "@deepagents/evals";
import { defineOolongMultinliSuite } from "./multinli.js";

const runner = getDefaultRunner();

ls.describe(
  runner.name,
  () => {
    defineOolongMultinliSuite(runner);
  },
  { projectName: "deepagents-js-oolong-multinli", upsert: true },
);
