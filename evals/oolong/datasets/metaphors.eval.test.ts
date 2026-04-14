import * as ls from "langsmith/vitest";
import { getDefaultRunner } from "@deepagents/evals";
import { oolongMetaphorsSuite } from "./metaphors.js";

const runner = getDefaultRunner();

ls.describe(
  runner.name,
  () => {
    oolongMetaphorsSuite(runner);
  },
  { projectName: "deepagents-js-oolong-metaphors", upsert: true },
);
