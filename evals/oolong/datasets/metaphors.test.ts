import * as ls from "langsmith/vitest";
import { getDefaultRunner } from "@deepagents/evals";
import { loadOolongTasksByDataset } from "../load-oolong.js";
import { makeOolongTests } from "../make-tests.js";

const runner = getDefaultRunner();
const tasks = (await loadOolongTasksByDataset()).get("metaphors") ?? [];

ls.describe(
  process.env.LANGSMITH_EVAL_DATASET ?? runner.name,
  () => {
    makeOolongTests(tasks);
  },
  { projectName: process.env.LANGSMITH_EVAL_PROJECT ?? "deepagents-js-oolong-metaphors", upsert: true },
);
