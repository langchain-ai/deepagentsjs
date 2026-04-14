import { getDefaultRunner } from "@deepagents/evals";
import { oolongFormalitySuite } from "./formality.js";

const runner = getDefaultRunner();

ls.describe(
  runner.name,
  () => {
    oolongFormalitySuite(runner);
  },
  { projectName: "deepagents-js-oolong-formality", upsert: true },
);
