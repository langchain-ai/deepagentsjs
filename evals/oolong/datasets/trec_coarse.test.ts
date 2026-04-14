import * as ls from "langsmith/vitest";
import { getDefaultRunner } from "@deepagents/evals";
import { defineOolongTrecCoarseSuite, getOolongTrecCoarseDatasetName, getOolongTrecCoarseDescribeOptions } from "./trec_coarse.suite.js";

const runner = getDefaultRunner();

ls.describe(
  getOolongTrecCoarseDatasetName(runner),
  () => {
    defineOolongTrecCoarseSuite(runner);
  },
  getOolongTrecCoarseDescribeOptions(runner),
);
