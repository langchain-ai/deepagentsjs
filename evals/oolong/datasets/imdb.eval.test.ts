import * as ls from "langsmith/vitest";
import { getDefaultRunner } from "@deepagents/evals";
import { defineOolongImdbSuite } from "./imdb.js";

const runner = getDefaultRunner();

ls.describe(
  runner.name,
  () => {
    defineOolongImdbSuite(runner);
  },
  { projectName: "deepagents-js-oolong-imdb", upsert: true },
);
