import * as ls from "langsmith/vitest";
import { getDefaultRunner } from "@deepagents/evals";
import { memorySuite } from "./index.js";

const runner = getDefaultRunner();

ls.describe(
  "deepagents-js-memory",
  () => {
    memorySuite(runner);
  },
  { projectName: runner.name, upsert: true },
);
