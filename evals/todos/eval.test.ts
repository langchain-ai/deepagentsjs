import * as ls from "langsmith/vitest";
import { getDefaultRunner } from "@deepagents/evals";
import { defineTodosSuite } from "./index.js";

const runner = getDefaultRunner();

ls.describe(
  "deepagents-js-todos",
  () => {
    defineTodosSuite(runner);
  },
  { projectName: runner.name, upsert: true },
);
