import * as ls from "langsmith/vitest";
import { getDefaultRunner } from "@deepagents/evals";
import { defineOolongMetaphorsSuite } from "./metaphors.js";

const runner = getDefaultRunner();

ls.describe(
  runner.name,
  () => {
    defineOolongMetaphorsSuite(runner);
  },
  { projectName: "deepagents-js-oolong-metaphors", upsert: true },
);
