import * as ls from "langsmith/vitest";
import { getDefaultRunner } from "@deepagents/evals";
import { tau2AirlineSuite } from "./index.js";

const runner = getDefaultRunner();

ls.describe(
  "deepagents-js-tau2-airline",
  () => {
    tau2AirlineSuite(runner);
  },
  { projectName: runner.name, upsert: true },
);
