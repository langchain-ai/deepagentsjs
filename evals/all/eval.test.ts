import * as ls from "langsmith/vitest";
import { getDefaultRunner } from "@deepagents/evals";
import { defineBasicSuite } from "../basic/index.js";
import { defineExternalBenchmarksSuite } from "../external-benchmarks/index.js";
import { defineFilesSuite } from "../files/index.js";
import { defineFollowupQualitySuite } from "../followup-quality/index.js";
import { defineHitlSuite } from "../hitl/index.js";
import { defineMemorySuite } from "../memory/index.js";
import { defineMemoryAgentBenchSuite } from "../memory-agent-bench/index.js";
import { defineMemoryMultiturnSuite } from "../memory-multiturn/index.js";
import { defineOolongAgnewsSuite } from "../oolong/datasets/agnews.js";
import { defineOolongAppReviewsSuite } from "../oolong/datasets/app_reviews.js";
import { defineOolongFormalitySuite } from "../oolong/datasets/formality.js";
import { defineOolongImdbSuite } from "../oolong/datasets/imdb.js";
import { defineOolongMetaphorsSuite } from "../oolong/datasets/metaphors.js";
import { defineOolongMultinliSuite } from "../oolong/datasets/multinli.js";
import { defineOolongNegationSuite } from "../oolong/datasets/negation.js";
import { defineOolongSpamSuite } from "../oolong/datasets/spam.js";
import { defineOolongTrecCoarseSuite } from "../oolong/datasets/trec_coarse.js";
import { defineOolongYahooSuite } from "../oolong/datasets/yahoo.js";
import { defineSkillsSuite } from "../skills/index.js";
import { defineSubagentsSuite } from "../subagents/index.js";
import { defineSummarizationSuite } from "../summarization/index.js";
import { defineTau2AirlineSuite } from "../tau2-airline/index.js";
import { defineTodosSuite } from "../todos/index.js";
import { defineToolSelectionSuite } from "../tool-selection/index.js";
import { defineToolUsageRelationalSuite } from "../tool-usage-relational/index.js";

const runner = getDefaultRunner();

ls.describe(
  "deepagents-js-all",
  () => {
    defineBasicSuite(runner);
    defineExternalBenchmarksSuite(runner);
    defineFilesSuite(runner);
    defineFollowupQualitySuite(runner);
    defineHitlSuite(runner);
    defineMemorySuite(runner);
    defineMemoryAgentBenchSuite(runner);
    defineMemoryMultiturnSuite(runner);
    defineOolongAgnewsSuite(runner);
    defineOolongAppReviewsSuite(runner);
    defineOolongFormalitySuite(runner);
    defineOolongImdbSuite(runner);
    defineOolongMetaphorsSuite(runner);
    defineOolongMultinliSuite(runner);
    defineOolongNegationSuite(runner);
    defineOolongSpamSuite(runner);
    defineOolongTrecCoarseSuite(runner);
    defineOolongYahooSuite(runner);
    defineSkillsSuite(runner);
    defineSubagentsSuite(runner);
    defineSummarizationSuite(runner);
    defineTau2AirlineSuite(runner);
    defineTodosSuite(runner);
    defineToolSelectionSuite(runner);
    defineToolUsageRelationalSuite(runner);
  },
  { projectName: runner.name, upsert: true },
);
