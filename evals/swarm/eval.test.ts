import * as ls from "langsmith/vitest";
import { getDefaultRunner } from "@deepagents/evals";
import { swarmSuite } from "./index.js";

const runner = getDefaultRunner();

// Unique experiment name per run. A fixed projectName collides on re-runs
// (LangSmith can't mint a unique name and the suite fails to start), so we
// suffix the runner name with a timestamp. All runs still group under the
// "deepagents-js-swarm" dataset for comparison.
const stamp = new Date().toISOString().slice(0, 19).replace(/[:T-]/g, "");

ls.describe(
  "deepagents-js-swarm",
  () => {
    swarmSuite(runner);
  },
  { projectName: `${runner.name}-${stamp}`, upsert: true },
);
