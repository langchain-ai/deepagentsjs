import * as ls from "langsmith/vitest";
import { getDefaultRunner } from "@deepagents/evals";
import { oolongSpamSuite } from "./spam.js";

const runner = getDefaultRunner();

ls.describe(
  runner.name,
  () => {
    oolongSpamSuite(runner);
  },
  { projectName: "deepagents-js-oolong-spam", upsert: true },
);
