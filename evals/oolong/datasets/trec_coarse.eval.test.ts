import * as ls from "langsmith/vitest";
import { getDefaultRunner } from "@deepagents/evals";
import { defineOolongTrecCoarseSuite } from "./trec_coarse.js";

const runner = getDefaultRunner();

ls.describe(
  runner.name,
  () => {
    defineOolongTrecCoarseSuite(runner);
  },
  { projectName: "deepagents-js-oolong-trec-coarse", upsert: true },
);
