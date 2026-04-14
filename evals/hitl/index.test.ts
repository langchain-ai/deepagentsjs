import * as ls from "langsmith/vitest";
import { getDefaultRunner } from "@deepagents/evals";
import {
  defineHitlSuite,
  getHitlDatasetName,
  getHitlDescribeOptions,
} from "./suite.js";

const runner = getDefaultRunner();

ls.describe(
  getHitlDatasetName(runner),
  () => {
    defineHitlSuite(runner);
  },
  getHitlDescribeOptions(runner),
);
