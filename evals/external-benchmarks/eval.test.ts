import * as ls from "langsmith/vitest";
import { getDefaultRunner } from "@deepagents/evals";
import { defineExternalBenchmarksSuite } from "./index.js";

const runner = getDefaultRunner();

ls.describe(
  "deepagents-js-external-benchmarks",
  () => {
    defineExternalBenchmarksSuite(runner);
  },
  { projectName: runner.name, upsert: true },
);
