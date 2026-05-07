import * as ls from "langsmith/vitest";
import { oolongImdbSuite } from "./imdb.js";

ls.describe(
  "deepagents-js-oolong-imdb",
  () => {
    oolongImdbSuite();
  },
  { projectName: "imdb-baseline", upsert: true },
);
