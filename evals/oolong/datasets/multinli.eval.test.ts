import * as ls from "langsmith/vitest";
import { oolongMultinliSuite } from "./multinli.js";

ls.describe(
  "deepagents-js-oolong-multinli",
  () => {
    oolongMultinliSuite();
  },
  { projectName: "multinli-baseline", upsert: true },
);
