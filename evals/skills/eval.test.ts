import * as ls from "langsmith/vitest";
import { getDefaultRunner } from "@deepagents/evals";
import { defineSkillsSuite } from "./index.js";

const runner = getDefaultRunner();

ls.describe(
  "deepagents-js-skills",
  () => {
    defineSkillsSuite(runner);
  },
  { projectName: runner.name, upsert: true },
);
