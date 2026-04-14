import * as ls from "langsmith/vitest";
import { getDefaultRunner } from "@deepagents/evals";
import { defineOolongSpamSuite } from "./spam.js";

const runner = getDefaultRunner();

ls.describe(
  runner.name,
  () => {
    defineOolongSpamSuite(runner);
  },
  { projectName: "deepagents-js-oolong-spam", upsert: true },
);
