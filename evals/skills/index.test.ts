import * as ls from "langsmith/vitest";
import { getDefaultRunner } from "@deepagents/evals";
import { defineSkillsSuite, getSkillsDatasetName, getSkillsDescribeOptions } from "./suite.js";

const runner = getDefaultRunner();

ls.describe(
  getSkillsDatasetName(runner),
  () => {
    defineSkillsSuite(runner);
  },
  getSkillsDescribeOptions(runner),
);
