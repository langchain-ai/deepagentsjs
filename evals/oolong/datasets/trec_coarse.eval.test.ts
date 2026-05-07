import * as ls from "langsmith/vitest";
import { oolongTrecCoarseSuite } from "./trec_coarse.js";

ls.describe(
  "swarm-skill-evals",
  () => {
    oolongTrecCoarseSuite();
  },
  { projectName: "baseline-trec-coarse", upsert: true },
);
