import * as ls from "langsmith/vitest";
import { getDefaultRunner } from "@deepagents/evals";
import { loadOolongTasksByDataset } from "../load-oolong.js";
import { makeOolongTests } from "../make-tests.js";

const runner = getDefaultRunner();
const tasks = (await loadOolongTasksByDataset()).get("agnews") ?? [];

ls.describe(
  runner.name,
  () => {
    makeOolongTests(tasks);
  },
  { projectName: "deepagents-js-oolong-agnews", upsert: true },
);
