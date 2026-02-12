import {
  tool,
  createMiddleware,
  ReactAgent,
  StructuredTool,
  ToolMessage,
  type AgentMiddleware as _AgentMiddleware,
} from "langchain";
import { Command } from "@langchain/langgraph";
import { z } from "zod/v4";

/**
 * required for type inference
 */
import type * as _zodTypes from "@langchain/core/utils/types";
import type * as _zodMeta from "@langchain/langgraph/zod";
import type * as _messages from "@langchain/core/messages";
import type * as _tools from "@langchain/core/tools";

const expectedTools = [
  "write_todos",
  "ls",
  "read_file",
  "write_file",
  "edit_file",
  "task",
];

/**
 * Assert that an agent has all the expected deep agent qualities
 * Accepts any object with a graph property (compatible with ReactAgent and DeepAgent types)
 */
export function assertAllDeepAgentQualities(agent: {
  graph: ReactAgent<any>["graph"];
}) {
  // Check state channels
  const channels = Object.keys(agent.graph?.channels || {});
  if (!channels.includes("todos")) {
    throw new Error(
      `Expected agent to have 'todos' channel, got: ${channels.join(", ")}`,
    );
  }
  if (!channels.includes("files")) {
    throw new Error(
      `Expected agent to have 'files' channel, got: ${channels.join(", ")}`,
    );
  }

  // Check tools
  const tools = (agent as any).graph?.nodes?.tools?.bound?.tools || [];
  const toolNames = tools.map((t: StructuredTool) => t.name);
  for (const toolName of expectedTools) {
    if (!toolNames.includes(toolName)) {
      throw new Error(
        `Expected agent to have '${toolName}' tool, got: ${toolNames.join(", ")}`,
      );
    }
  }
}

/**
 * Constants
 */
export const SAMPLE_MODEL = "claude-sonnet-4-5-20250929";
export const SAMPLE_MODEL_WITH_STRUCTURED_RESPONSE = "claude-opus-4-6";

/**
 * Mock tools for testing
 */

export const getPremierLeagueStandings = tool(
  async (_, config) => {
    const longToolMsg =
      "This is a long tool message that should be evicted to the filesystem.\n".repeat(
        300,
      );
    return new Command({
      update: {
        messages: [
          new ToolMessage({
            content: longToolMsg,
            tool_call_id: config.toolCall?.id as string,
          }),
        ],
        files: {
          "/test.txt": {
            content: ["Goodbye world"],
            created_at: "2021-01-01",
            modified_at: "2021-01-01",
          },
        },
      },
    });
  },
  {
    name: "get_premier_league_standings",
    description: "Use this tool to get premier league standings",
    schema: z.object({}),
  },
);

export const getLaLigaStandings = tool(
  async (_, config) => {
    const longToolMsg =
      "This is a long tool message that should be evicted to the filesystem.\n".repeat(
        300,
      );
    return new Command({
      update: {
        messages: [
          new ToolMessage({
            content: longToolMsg,
            tool_call_id: config.toolCall?.id as string,
          }),
        ],
      },
    });
  },
  {
    name: "get_la_liga_standings",
    description: "Use this tool to get la liga standings",
    schema: z.object({}),
  },
);

export const getNbaStandings = tool(
  () => {
    return "Sample text that is too long to fit in the token limit\n".repeat(
      10000,
    );
  },
  {
    name: "get_nba_standings",
    description:
      "Use this tool to get a comprehensive report on the NBA standings",
    schema: z.object({}),
  },
);

export const getNflStandings = tool(
  () => {
    return "Sample text that is too long to fit in the token limit\n".repeat(
      100,
    );
  },
  {
    name: "get_nfl_standings",
    description:
      "Use this tool to get a comprehensive report on the NFL standings",
    schema: z.object({}),
  },
);

export const getWeather = tool(
  (input) => `The weather in ${input.location} is sunny.`,
  {
    name: "get_weather",
    description: "Use this tool to get the weather",
    schema: z.object({ location: z.string() }),
  },
);

export const getSoccerScores = tool(
  (input) => `The latest soccer scores for ${input.team} are 2-1.`,
  {
    name: "get_soccer_scores",
    description: "Use this tool to get the latest soccer scores",
    schema: z.object({
      team: z.string(),
    }),
  },
);

export const sampleTool = tool((input) => input.sample_input, {
  name: "sample_tool",
  description: "Sample tool",
  schema: z.object({
    sample_input: z.string(),
  }),
});

export const TOY_BASKETBALL_RESEARCH =
  "Lebron James is the best basketball player of all time with over 40k points and 21 seasons in the NBA.";

export const researchBasketball = tool(
  async (input, config) => {
    const state = (config as any).state || {};
    const currentResearch = state.research || "";
    const research = `${currentResearch}\n\nResearching on ${input.topic}... Done! ${TOY_BASKETBALL_RESEARCH}`;
    return new Command({
      update: {
        research,
        messages: [
          new ToolMessage({
            content: research,
            tool_call_id: config.toolCall?.id as string,
          }),
        ],
      },
    });
  },
  {
    name: "research_basketball",
    description:
      "Use this tool to conduct research into basketball and save it to state",
    schema: z.object({ topic: z.string() }),
  },
);

/**
 * Middleware classes for testing
 */

// Research state
const ResearchStateSchema = z.object({
  research: z
    .string()
    .default("")
    .meta({
      reducer: {
        fn: (left: string, right: string | null) => right || left || "",
        schema: z.string().nullable(),
      },
    }),
});

export const ResearchMiddleware = createMiddleware({
  name: "ResearchMiddleware",
  stateSchema: ResearchStateSchema,
});

export const ResearchMiddlewareWithTools = createMiddleware({
  name: "ResearchMiddlewareWithTools",
  stateSchema: ResearchStateSchema,
  tools: [researchBasketball],
});

export const SampleMiddlewareWithTools = createMiddleware({
  name: "SampleMiddlewareWithTools",
  tools: [sampleTool],
});

// Sample state
const SampleStateSchema = z.object({
  sample_input: z
    .string()
    .default("")
    .meta({
      reducer: {
        fn: (left: string, right: string | null) => right || left || "",
        schema: z.string().nullable(),
      },
    }),
});

export const SampleMiddlewareWithToolsAndState = createMiddleware({
  name: "SampleMiddlewareWithToolsAndState",
  stateSchema: SampleStateSchema,
  tools: [sampleTool],
});

export const WeatherToolMiddleware = createMiddleware({
  name: "WeatherToolMiddleware",
  tools: [getWeather],
});

export function extractToolsFromAgent(agent: {
  graph: ReactAgent<any>["graph"];
}) {
  const graph = agent.graph;
  const toolsNode = graph.nodes?.tools.bound as unknown as {
    tools: StructuredTool[];
  };

  return Object.fromEntries(
    (toolsNode.tools ?? []).map((tool) => [tool.name, tool]),
  );
}
