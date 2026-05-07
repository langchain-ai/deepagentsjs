import * as ls from "langsmith/vitest";
import { oolongSpamSuite } from "./spam.js";

ls.describe(
  "swarm-skill-evals",
  () => {
    oolongSpamSuite();
  },
  { projectName: "baseline-spam", upsert: true },
);
