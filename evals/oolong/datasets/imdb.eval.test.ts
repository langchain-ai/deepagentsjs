import * as ls from "langsmith/vitest";
import { getDefaultRunner } from "@deepagents/evals";
import { oolongImdbSuite } from "./imdb.js";

const runner = getDefaultRunner();

ls.describe(
  runner.name,
  () => {
    oolongImdbSuite(runner);
  },
  { projectName: "deepagents-js-oolong-imdb", upsert: true },
);
