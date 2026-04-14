import * as ls from "langsmith/vitest";
import { getDefaultRunner } from "@deepagents/evals";
import { defineOolongImdbSuite, getOolongImdbDatasetName, getOolongImdbDescribeOptions } from "./imdb.suite.js";

const runner = getDefaultRunner();

ls.describe(
  getOolongImdbDatasetName(runner),
  () => {
    defineOolongImdbSuite(runner);
  },
  getOolongImdbDescribeOptions(runner),
);
