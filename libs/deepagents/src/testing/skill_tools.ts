/**
 * Shared fixtures for the skill tool disclosure tests.
 *
 * Seeds skills as state files, builds the skill tools they name, scripts tool
 * calls, and stubs the HTTP transport of real provider chat models, so tests
 * can assert on the payload that leaves the process.
 */

import { ChatAnthropic } from "@langchain/anthropic";
import {
  BaseChatModel,
  type BaseChatModelCallOptions,
} from "@langchain/core/language_models/chat_models";
import {
  AIMessage,
  HumanMessage,
  ToolMessage,
  type BaseMessage,
  type ToolCall,
} from "@langchain/core/messages";
import type { ModelProfile } from "@langchain/core/language_models/profile";
import type { ChatResult } from "@langchain/core/outputs";
import { tool, type ClientTool } from "@langchain/core/tools";
import { AzureChatOpenAI, ChatOpenAI } from "@langchain/openai";
import { expect } from "vitest";
import { z } from "zod/v4";

import { createDeepAgent } from "../agent.js";
import { StateBackend } from "../backends/state.js";
import { createFileData } from "../backends/utils.js";
import type { FileData } from "../backends/protocol.js";
import {
  createSkillsMiddleware,
  type SkillsMiddlewareOptions,
} from "../middleware/skills.js";
import { createSummarizationMiddleware } from "../middleware/summarization.js";
import type { DeepAgent } from "../types.js";

export const SKILLS_SOURCE = "/skills/";
export const CRM_PATH = "/skills/crm/SKILL.md";
export const LINEAR_PATH = "/skills/linear/SKILL.md";
export const LIST_ISSUES = "mcp_linear_list_issues_ab12";
export const CREATE_ISSUE = "mcp_linear_create_issue_cd34";

/** Return a `SKILL.md` whose frontmatter names `includeTools`. */
export function skillMd(name: string, includeTools?: string): string {
  const metadata =
    includeTools !== undefined
      ? `metadata:\n  include_tools: ${includeTools}\n`
      : "";
  return `---\nname: ${name}\ndescription: Manage ${name}\n${metadata}---\n\n# ${name}\n\nFollow these steps.\n`;
}

/** Return a `SKILL.md` path for the skill `name`. */
export function skillPath(name: string): string {
  return `/skills/${name}/SKILL.md`;
}

/**
 * Return state `files` holding one skill per entry, each naming the given
 * `include_tools`, or with the given raw `SKILL.md` content.
 */
export function skillFiles(
  skills: Record<string, string | { content: string }>,
): Record<string, FileData> {
  return Object.fromEntries(
    Object.entries(skills).map(([name, spec]) => [
      skillPath(name),
      createFileData(
        typeof spec === "string" ? skillMd(name, spec) : spec.content,
      ),
    ]),
  );
}

export const createCustomerRequest = tool(
  async ({ title }, config) => `created ${title} (${config.toolCall?.id})`,
  {
    name: "create_customer_request",
    description: "Create a customer request.",
    schema: z.object({ title: z.string() }),
  },
);

export const listCustomerRequests = tool(async () => "no requests", {
  name: "list_customer_requests",
  description: "List customer requests.",
  schema: z.object({}),
});

export const searchTickets = tool(async ({ query }) => `tickets for ${query}`, {
  name: "search_tickets",
  description: "Search support tickets.",
  schema: z.object({ query: z.string() }),
  extras: { defer_loading: true },
});

export const listIssues = tool(async () => "no issues", {
  name: LIST_ISSUES,
  description: "List Linear issues.",
  schema: z.object({}),
});

export const createIssue = tool(
  async ({ title }, config) => `issue ${title} (${config.toolCall?.id})`,
  {
    name: CREATE_ISSUE,
    description: "Create a Linear issue.",
    schema: z.object({ title: z.string() }),
  },
);

/**
 * Return a `CREATE_ISSUE` tool that appends `ran <call id>` to `log` when it
 * runs. Sharing a resolver's `calls` as `log` shows which name each tool-time
 * lookup used.
 */
export function loggedCreateIssue(log: string[]) {
  return tool(
    async ({ title }, config) => {
      log.push(`ran ${config.toolCall?.id}`);
      return `issue ${title} (${config.toolCall?.id})`;
    },
    {
      name: CREATE_ISSUE,
      description: "Create a Linear issue.",
      schema: z.object({ title: z.string() }),
    },
  );
}

/** A skill tool resolver over a map of names, recording every name it's asked for. */
export function recordingResolver(
  families: Record<string, readonly ClientTool[]> = {},
) {
  const calls: string[] = [];
  const state = { families };
  const resolve = (name: string) => {
    calls.push(name);
    return [...(state.families[name] ?? [])];
  };
  return Object.assign(resolve, {
    calls,
    setFamilies(next: Record<string, readonly ClientTool[]>) {
      state.families = next;
    },
  });
}

/** Return a resolver mapping `linear` to both Linear tools. */
export function linearResolver() {
  return recordingResolver({ linear: [listIssues, createIssue] });
}

/** Return a tool call as the model would emit it. */
export function call(
  name: string,
  id: string,
  args: Record<string, unknown> = {},
): ToolCall {
  return { name, args, id, type: "tool_call" };
}

/** Return a `read_file` call for `path`. */
export function read(
  id: string,
  path: string = CRM_PATH,
  args: Record<string, unknown> = {},
): ToolCall {
  return call("read_file", id, { file_path: path, ...args });
}

/** Return an assistant turn making `calls`. */
export function ai(...calls: ToolCall[]): AIMessage {
  return new AIMessage({ content: "", tool_calls: calls });
}

type AgentOptions = NonNullable<Parameters<typeof createDeepAgent>[0]>;

/**
 * Build a deep agent over `/skills/` whose skills middleware discloses
 * `skillTools` (by default `create_customer_request`), passed in `middleware`
 * as callers give skills their tools.
 */
export function skillsAgent(
  model: unknown,
  options: AgentOptions & {
    skillTools?: SkillsMiddlewareOptions["tools"];
  } = {},
): DeepAgent {
  const { skillTools, middleware = [], ...rest } = options;
  const skills = createSkillsMiddleware({
    backend: new StateBackend(),
    sources: [SKILLS_SOURCE],
    tools: "skillTools" in options ? skillTools : [createCustomerRequest],
  });
  return createDeepAgent({
    model,
    skills: [SKILLS_SOURCE],
    middleware: [...middleware, skills],
    ...rest,
  } as AgentOptions) as unknown as DeepAgent;
}

/** Return the input for one run over `skills`, seeded as state files. */
export function skillsInput(
  skills: Record<string, string | { content: string }>,
  messages: BaseMessage[] = [new HumanMessage("go")],
) {
  return { messages, files: skillFiles(skills) } as any;
}

/**
 * Summarize once the effective conversation reaches `trigger` messages,
 * keeping the last `keep`.
 *
 * The summary is generated by the request's model, so a test scripting the
 * agent's model must include the summary as a turn of its own, and a provider
 * stub sees its request.
 */
export function compacting(trigger: number, keep: number) {
  return createSummarizationMiddleware({
    backend: new StateBackend(),
    trigger: { type: "messages", value: trigger },
    keep: { type: "messages", value: keep },
  });
}

/** Return a `task` call delegating to `subagentType`. */
export function task(subagentType: string, id = "t1"): AIMessage {
  return ai(
    call("task", id, {
      description: "do the work",
      subagent_type: subagentType,
    }),
  );
}

/** Assert `message` is the tool node's invalid-tool error for `name`. */
export function expectInvalidTool(
  message: ToolMessage | undefined,
  name: string,
) {
  expect(message?.content).toMatch(
    new RegExp(`^Error: ${name} is not a valid tool`),
  );
  expect(message?.status).toBe("error");
}

/** Return the `ToolMessage`s in `result` produced for tool `name`. */
export function toolMessages(
  result: { messages: BaseMessage[] },
  name: string,
): ToolMessage[] {
  return result.messages.filter(
    (m): m is ToolMessage => ToolMessage.isInstance(m) && m.name === name,
  );
}

/** One call a {@link RecordingChatModel} received. */
export interface RecordedCall {
  messages: BaseMessage[];
  tools: unknown[];
}

/** A scripted turn: a reply, or an error to throw in place of one. */
export type ScriptedTurn = AIMessage | string | Error;

interface RecordingCallOptions extends BaseChatModelCallOptions {
  tools?: unknown[];
}

/**
 * A chat model that records the messages and bound tools of every call and
 * plays scripted turns, then answers "done".
 *
 * It is neither `ChatAnthropic` nor `ChatOpenAI`, so it takes the path for
 * models without mid-conversation tool definitions.
 */
export class RecordingChatModel extends BaseChatModel<RecordingCallOptions> {
  readonly calls: RecordedCall[] = [];

  /** Overrides the model's profile, e.g. to give summarization a context window. */
  modelProfile?: ModelProfile;

  readonly #turns: ScriptedTurn[];

  constructor(...turns: ScriptedTurn[]) {
    super({});
    this.#turns = turns;
  }

  override get profile(): ModelProfile {
    return this.modelProfile ?? super.profile;
  }

  _llmType(): string {
    return "recording";
  }

  override bindTools(tools: unknown[]) {
    return this.withConfig({ tools } as Partial<RecordingCallOptions>);
  }

  async _generate(
    messages: BaseMessage[],
    options: this["ParsedCallOptions"],
  ): Promise<ChatResult> {
    this.calls.push({ messages, tools: options.tools ?? [] });
    const turn = this.#turns.shift() ?? "done";
    let message: AIMessage;
    if (typeof turn === "string") message = new AIMessage({ content: turn });
    else if (AIMessage.isInstance(turn)) message = turn;
    else throw turn;
    return { generations: [{ text: message.text, message }] };
  }
}

/** Return the names of the tools one recorded call was bound with. */
export function boundToolNames(recorded: RecordedCall): string[] {
  return recorded.tools.map((t) => (t as { name: string }).name);
}

/** Return the tools named `name` that one recorded call was bound with. */
export function boundTools(
  recorded: RecordedCall,
  name: string,
): Record<string, unknown>[] {
  return recorded.tools.filter(
    (t) => (t as { name?: string }).name === name,
  ) as Record<string, unknown>[];
}

/** A scripted provider turn: text, tool calls, or a raw HTTP response. */
export type ProviderTurn = string | ToolCall[] | Response;

/** One request a {@link ProviderStub} received. */
export interface RecordedRequest {
  url: string;
  headers: Headers;
  body: any;
}

/** Answer provider HTTP requests from a script, recording each request. */
export class ProviderStub {
  readonly requests: RecordedRequest[] = [];

  constructor(
    private readonly render: (
      index: number,
      turn: string | ToolCall[],
    ) => unknown,
    private readonly turns: ProviderTurn[],
  ) {}

  /** A `fetch` that records the request and answers with the next turn. */
  readonly fetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const request = new Request(input, init);
    const index = this.requests.length;
    this.requests.push({
      url: request.url,
      headers: request.headers,
      body: JSON.parse(await request.text()),
    });
    const turn = this.turns[index] ?? "done";
    if (typeof turn !== "string" && !Array.isArray(turn)) return turn;
    return new Response(JSON.stringify(this.render(index, turn)), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  /** Every request body, decoded. */
  get bodies(): any[] {
    return this.requests.map((r) => r.body);
  }
}

/** Render a scripted turn as an Anthropic Messages API response. */
export function anthropicMessage(index: number, turn: string | ToolCall[]) {
  const content =
    typeof turn === "string"
      ? [{ type: "text", text: turn }]
      : turn.map((c) => ({
          type: "tool_use",
          id: c.id,
          name: c.name,
          input: c.args,
        }));
  return {
    id: `msg_${index}`,
    type: "message",
    role: "assistant",
    model: "claude",
    content,
    stop_reason: typeof turn === "string" ? "end_turn" : "tool_use",
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5 },
  };
}

/** Render a scripted turn as an OpenAI Responses API response. */
export function openaiResponse(index: number, turn: string | ToolCall[]) {
  const output =
    typeof turn === "string"
      ? [
          {
            type: "message",
            id: `msg_${index}`,
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: turn, annotations: [] }],
          },
        ]
      : turn.map((c) => ({
          type: "function_call",
          id: `fc_${c.id}`,
          call_id: c.id,
          name: c.name,
          arguments: JSON.stringify(c.args),
          status: "completed",
        }));
  return {
    id: `resp_${index}`,
    object: "response",
    created_at: 0,
    model: "gpt",
    status: "completed",
    output,
    parallel_tool_calls: true,
    tool_choice: "auto",
    tools: [],
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      total_tokens: 15,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    },
  };
}

/** Render a scripted turn as an OpenAI Chat Completions response. */
export function openaiChatCompletion(index: number, turn: string | ToolCall[]) {
  const toolCalls =
    typeof turn === "string"
      ? undefined
      : turn.map((c) => ({
          id: c.id,
          type: "function",
          function: { name: c.name, arguments: JSON.stringify(c.args) },
        }));
  return {
    id: `chatcmpl-${index}`,
    object: "chat.completion",
    created: 0,
    model: "gpt",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: typeof turn === "string" ? turn : null,
          tool_calls: toolCalls,
        },
        finish_reason: typeof turn === "string" ? "stop" : "tool_calls",
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

/** Return a real `ChatAnthropic` whose HTTP transport answers from `turns`. */
export function stubAnthropic(
  turns: ProviderTurn[],
  model = "claude-opus-5-5",
) {
  const stub = new ProviderStub(anthropicMessage, turns);
  const chatModel = new ChatAnthropic({
    model,
    apiKey: "test-key",
    maxRetries: 0,
    clientOptions: { fetch: stub.fetch },
  });
  return { model: chatModel, stub };
}

/** Return a real `ChatOpenAI` whose HTTP transport answers from `turns`. */
export function stubOpenAI(
  turns: ProviderTurn[],
  { model = "gpt-6-astra", useResponsesApi = true } = {},
) {
  const stub = new ProviderStub(
    useResponsesApi ? openaiResponse : openaiChatCompletion,
    turns,
  );
  const chatModel = new ChatOpenAI({
    model,
    apiKey: "test-key",
    maxRetries: 0,
    useResponsesApi,
    configuration: { fetch: stub.fetch },
  });
  return { model: chatModel, stub };
}

/** Return a real `AzureChatOpenAI` whose HTTP transport answers from `turns`. */
export function stubAzureOpenAI(turns: ProviderTurn[]) {
  const stub = new ProviderStub(openaiChatCompletion, turns);
  const chatModel = new AzureChatOpenAI({
    model: "gpt-6-astra",
    azureOpenAIApiKey: "test-key",
    azureOpenAIApiInstanceName: "test",
    azureOpenAIApiDeploymentName: "gpt-6-astra",
    azureOpenAIApiVersion: "2025-04-01-preview",
    maxRetries: 0,
    configuration: { fetch: stub.fetch },
  });
  return { model: chatModel, stub };
}
