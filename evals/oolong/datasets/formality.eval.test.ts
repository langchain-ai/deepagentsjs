import * as ls from "langsmith/vitest";
import { getDefaultRunner } from "@deepagents/evals";
import { defineOolongFormalitySuite } from "./formality.js";

const runner = getDefaultRunner();

ls.describe(
  runner.name,
  () => {
    defineOolongFormalitySuite(runner);
  },
  { projectName: "deepagents-js-oolong-formality", upsert: true },
);
