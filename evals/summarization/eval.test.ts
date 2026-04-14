import * as ls from "langsmith/vitest";
import { getDefaultRunner } from "@deepagents/evals";
import { defineSummarizationSuite } from "./index.js";

const runner = getDefaultRunner();

ls.describe(
  "deepagents-js-summarization",
  () => {
    defineSummarizationSuite(runner);
  },
  { projectName: runner.name, upsert: true },
);
