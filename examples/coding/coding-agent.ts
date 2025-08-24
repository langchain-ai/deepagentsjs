/* eslint-disable no-console */
import { createDeepAgent, type SubAgent } from "../../src/index.js";
import "dotenv/config";
import { code_reviewer_agent, test_generator_agent } from "./subagents.js";
import { get_coding_instructions } from "./coding_instructions.js";
import { createCodingAgentPostModelHook } from "./coding_post_model_hook.js";
import { CodingAgentState } from "./coding_agent_state.js";
import { executeBash, httpRequest, webSearch } from "./tools.js";

// LangSmith tracing setup
if (process.env.LANGCHAIN_TRACING_V2 !== "false") {
  process.env.LANGCHAIN_TRACING_V2 = "true";
  if (!process.env.LANGCHAIN_PROJECT) {
    process.env.LANGCHAIN_PROJECT = "coding-agent";
  }
}


const codingInstructions = get_coding_instructions();
const postModelHook = createCodingAgentPostModelHook();

// Create the coding agent
const agent = createDeepAgent({
  tools: [executeBash, httpRequest, webSearch],
  instructions: codingInstructions,
  subagents: [code_reviewer_agent, test_generator_agent],
  isLocalFileSystem: true,
  postModelHook: postModelHook,
  stateSchema: CodingAgentState,
}).withConfig({ recursionLimit: 1000 });


export { agent, executeBash, httpRequest, webSearch };