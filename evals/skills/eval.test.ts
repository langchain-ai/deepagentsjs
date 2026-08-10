import * as ls from "langsmith/vitest";
import { getDefaultRunner } from "@deepagents/evals";
import { skillsSuite } from "./index.js";

const runner = getDefaultRunner();

ls.describe(
  "deepagents-js-skills",
  () => {
    skillsSuite(runner);
  },
  { projectName: runner.name, upsert: true },
);
