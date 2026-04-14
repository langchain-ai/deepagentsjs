import * as ls from "langsmith/vitest";
import { getDefaultRunner } from "@deepagents/evals";
import { defineOolongFormalitySuite, getOolongFormalityDatasetName, getOolongFormalityDescribeOptions } from "./formality.suite.js";

const runner = getDefaultRunner();

ls.describe(
  getOolongFormalityDatasetName(runner),
  () => {
    defineOolongFormalitySuite(runner);
  },
  getOolongFormalityDescribeOptions(runner),
);
