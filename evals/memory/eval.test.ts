import * as ls from "langsmith/vitest";
import { getDefaultRunner } from "@deepagents/evals";
import { defineMemorySuite } from "./index.js";

const runner = getDefaultRunner();

ls.describe(
  "deepagents-js-memory",
  () => {
    defineMemorySuite(runner);
  },
  { projectName: runner.name, upsert: true },
);
