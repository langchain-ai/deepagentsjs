import * as ls from "langsmith/vitest";
import { getDefaultRunner } from "@deepagents/evals";
import { basicSuite } from "../basic/index.js";
import { externalBenchmarksSuite } from "../external-benchmarks/index.js";
import { filesSuite } from "../files/index.js";
import { followupQualitySuite } from "../followup-quality/index.js";
import { hitlSuite } from "../hitl/index.js";
import { memorySuite } from "../memory/index.js";
import { memoryAgentBenchSuite } from "../memory-agent-bench/index.js";
import { memoryMultiturnSuite } from "../memory-multiturn/index.js";
// import { oolongAgnewsSuite } from "../oolong/datasets/agnews.js";
// import { oolongAppReviewsSuite } from "../oolong/datasets/app_reviews.js";
// import { oolongFormalitySuite } from "../oolong/datasets/formality.js";
// import { oolongImdbSuite } from "../oolong/datasets/imdb.js";
// import { oolongMetaphorsSuite } from "../oolong/datasets/metaphors.js";
// import { oolongMultinliSuite } from "../oolong/datasets/multinli.js";
// import { oolongNegationSuite } from "../oolong/datasets/negation.js";
// import { oolongSpamSuite } from "../oolong/datasets/spam.js";
// import { oolongTrecCoarseSuite } from "../oolong/datasets/trec_coarse.js";
// import { oolongYahooSuite } from "../oolong/datasets/yahoo.js";
import { skillsSuite } from "../skills/index.js";
import { subagentsSuite } from "../subagents/index.js";
import { summarizationSuite } from "../summarization/index.js";
import { tau2AirlineSuite } from "../tau2-airline/index.js";
import { todosSuite } from "../todos/index.js";
import { toolSelectionSuite } from "../tool-selection/index.js";
import { toolUsageRelationalSuite } from "../tool-usage-relational/index.js";

const runner = getDefaultRunner();

ls.describe(
  "deepagents-js-all",
  () => {
    basicSuite(runner);
    externalBenchmarksSuite(runner);
    filesSuite(runner);
    followupQualitySuite(runner);
    hitlSuite(runner);
    memorySuite(runner);
    memoryAgentBenchSuite(runner);
    memoryMultiturnSuite(runner);
    // oolongAgnewsSuite(runner);
    // oolongAppReviewsSuite(runner);
    // oolongFormalitySuite(runner);
    // oolongImdbSuite(runner);
    // oolongMetaphorsSuite(runner);
    // oolongMultinliSuite(runner);
    // oolongNegationSuite(runner);
    // oolongSpamSuite(runner);
    // oolongTrecCoarseSuite(runner);
    // oolongYahooSuite(runner);
    skillsSuite(runner);
    subagentsSuite(runner);
    summarizationSuite(runner);
    tau2AirlineSuite(runner);
    todosSuite(runner);
    toolSelectionSuite(runner);
    toolUsageRelationalSuite(runner);
  },
  { projectName: runner.name, upsert: true },
);
