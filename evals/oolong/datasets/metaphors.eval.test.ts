import * as ls from "langsmith/vitest";
import { oolongMetaphorsSuite } from "./metaphors.js";

ls.describe(
  "swarm-skill-evals",
  () => {
    oolongMetaphorsSuite();
  },
  { projectName: "baseline-metaphors", upsert: true },
);
