import { getDefaultRunner } from "@deepagents/evals";
import * as ls from "langsmith/vitest";
import { oolongTrecCoarseSuite } from "./trec_coarse.js";

const runner = getDefaultRunner();

ls.describe(
  runner.name,
  () => {
    oolongTrecCoarseSuite(runner);
  },
  { projectName: "deepagents-js-oolong-trec-coarse", upsert: true },
);
