import * as ls from "langsmith/vitest";
import { oolongAgnewsSuite } from "./agnews.js";

ls.describe(
  "deepagents-js-oolong-agnews",
  () => {
    oolongAgnewsSuite();
  },
  { projectName: "agnews-baseline", upsert: true },
);
