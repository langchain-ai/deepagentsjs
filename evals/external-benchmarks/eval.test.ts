import * as ls from "langsmith/vitest";
import { getDefaultRunner } from "@deepagents/evals";
import { externalBenchmarksSuite } from "./index.js";

const runner = getDefaultRunner();

ls.describe(
  "deepagents-js-external-benchmarks",
  () => {
    externalBenchmarksSuite(runner);
  },
  { projectName: runner.name, upsert: true },
);
