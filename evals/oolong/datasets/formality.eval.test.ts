import { getDefaultRunner } from "@deepagents/evals";
import * as ls from "langsmith/vitest";
import { oolongFormalitySuite } from "./formality.js";

const runner = getDefaultRunner();

ls.describe(
  runner.name,
  () => {
    oolongFormalitySuite(runner);
  },
  { projectName: "deepagents-js-oolong-formality", upsert: true },
);
