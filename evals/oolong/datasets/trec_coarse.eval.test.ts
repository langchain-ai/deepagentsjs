import { getDefaultRunner } from "@deepagents/evals";
import * as ls from "langsmith/vitest";
import { oolongTrecCoarseSuite } from "./trec_coarse.js";

const runner = getDefaultRunner();

ls.describe(
  "deepagents-js-oolong-trec-coarse",
  () => {
    oolongTrecCoarseSuite(runner);
  },
  { projectName: runner.name, upsert: true },
);
