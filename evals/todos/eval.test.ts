import * as ls from "langsmith/vitest";
import { getDefaultRunner } from "@deepagents/evals";
import { todosSuite } from "./index.js";

const runner = getDefaultRunner();

ls.describe(
  "deepagents-js-todos",
  () => {
    todosSuite(runner);
  },
  { projectName: runner.name, upsert: true },
);
