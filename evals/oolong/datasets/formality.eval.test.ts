import * as ls from "langsmith/vitest";
import { oolongFormalitySuite } from "./formality.js";

ls.describe(
  "deepagents-js-oolong-formality",
  () => {
    oolongFormalitySuite();
  },
  { projectName: "formality-baseline", upsert: true },
);
