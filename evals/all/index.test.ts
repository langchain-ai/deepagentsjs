import * as ls from "langsmith/vitest";
import { getDefaultRunner } from "@deepagents/evals";
import { defineBasicSuite } from "../basic/suite.js";
import { defineExternalBenchmarksSuite } from "../external-benchmarks/suite.js";
import { defineFilesSuite } from "../files/suite.js";
import { defineFollowupQualitySuite } from "../followup-quality/suite.js";
import { defineHitlSuite } from "../hitl/suite.js";
import { defineMemorySuite } from "../memory/suite.js";
import { defineMemoryAgentBenchSuite } from "../memory-agent-bench/suite.js";
import { defineMemoryMultiturnSuite } from "../memory-multiturn/suite.js";
import { defineOolongAgnewsSuite } from "../oolong/datasets/agnews.suite.js";
import { defineOolongAppReviewsSuite } from "../oolong/datasets/app_reviews.suite.js";
import { defineOolongFormalitySuite } from "../oolong/datasets/formality.suite.js";
import { defineOolongImdbSuite } from "../oolong/datasets/imdb.suite.js";
import { defineOolongMetaphorsSuite } from "../oolong/datasets/metaphors.suite.js";
import { defineOolongMultinliSuite } from "../oolong/datasets/multinli.suite.js";
import { defineOolongNegationSuite } from "../oolong/datasets/negation.suite.js";
import { defineOolongSpamSuite } from "../oolong/datasets/spam.suite.js";
import { defineOolongTrecCoarseSuite } from "../oolong/datasets/trec_coarse.suite.js";
import { defineOolongYahooSuite } from "../oolong/datasets/yahoo.suite.js";
import { defineSkillsSuite } from "../skills/suite.js";
import { defineSubagentsSuite } from "../subagents/suite.js";
import { defineSummarizationSuite } from "../summarization/suite.js";
import { defineTau2AirlineSuite } from "../tau2-airline/suite.js";
import { defineTodosSuite } from "../todos/suite.js";
import { defineToolSelectionSuite } from "../tool-selection/suite.js";
import { defineToolUsageRelationalSuite } from "../tool-usage-relational/suite.js";

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
