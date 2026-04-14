import * as ls from "langsmith/vitest";
import { getDefaultRunner } from "@deepagents/evals";
import { defineTau2AirlineSuite } from "./index.js";

const runner = getDefaultRunner();

ls.describe(
  "deepagents-js-tau2-airline",
  () => {
    defineTau2AirlineSuite(runner);
  },
  { projectName: runner.name, upsert: true },
);
