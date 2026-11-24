import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatAnthropic } from "@langchain/anthropic";
import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import {
  AIMessage,
  AIMessageChunk,
  HumanMessage,
  ToolMessage,
} from "@langchain/core/messages";
import { createAgent, tool } from "langchain";
import { z } from "zod/v4";

import {
  anthropicCacheKeepaliveMiddleware,
  expectedCacheSavings,
  type AnthropicCacheKeepaliveMiddlewareOptions,
  type CachePricing,
} from "./cache_keepalive.js";

const INTERVAL = 50;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const fakeModel = (name: string, thinking?: unknown) => ({
  getName: () => name,
  thinking,
});

function modelRequest(anthropic = true, thinking?: unknown): any {
  return {
    model: fakeModel(
      anthropic ? "ChatAnthropic" : "FakeListChatModel",
      thinking,
    ),
    messages: [new HumanMessage("hi")],
    modelSettings: { cache_control: { type: "ephemeral" } },
    state: { messages: [] },
  };
}

function toolRequest(id: string): any {
  return {
    toolCall: { id, name: "slow", args: {} },
    tool: undefined,
    state: {},
    runtime: {},
  };
}

function toolCallMessage(ids: string[], promptTokens?: number): AIMessage {
  return new AIMessage({
    content: "",
    tool_calls: ids.map((id) => ({ id, name: "slow", args: {} })),
    usage_metadata:
      promptTokens === undefined
        ? undefined
        : {
            input_tokens: promptTokens,
            output_tokens: 10,
            total_tokens: promptTokens + 10,
          },
  });
}

/** Model handler that records ping requests after the first (real) call. */
class Recorder {
  calls: any[] = [];

  constructor(
    private ids: string[] = ["t1"],
    private opts: { failPings?: boolean; promptTokens?: number } = {},
  ) {}

  handler = async (request: any): Promise<AIMessage> => {
    this.calls.push(request);
    if (this.calls.length === 1) {
      return toolCallMessage(this.ids, this.opts.promptTokens);
    }
    if (this.opts.failPings) throw new Error("ping rejected");
    return new AIMessage("");
  };

  get pings() {
    return this.calls.slice(1);
  }
}

function slowTool(ms: (id: string) => number) {
  return async (request: any) => {
    await sleep(ms(request.toolCall.id));
    return new ToolMessage({
      content: "done",
      tool_call_id: request.toolCall.id,
    });
  };
}

async function run(
  options: AnthropicCacheKeepaliveMiddlewareOptions,
  recorder: Recorder,
  toolMs: number,
  anthropic = true,
  thinking?: unknown,
) {
  const mw = anthropicCacheKeepaliveMiddleware({
    interval: INTERVAL,
    ...options,
  });
  await mw.wrapModelCall!(modelRequest(anthropic, thinking), recorder.handler);
  return mw.wrapToolCall!(
    toolRequest("t1"),
    slowTool(() => toolMs),
  );
}

const OPUS_PRICING: CachePricing = { cacheRead: 0.2, cacheWrite: 5 };

describe("anthropicCacheKeepaliveMiddleware", () => {
  let warn: ReturnType<typeof vi.spyOn> | undefined;
  afterEach(() => warn?.mockRestore());

  it("pings while the tool runs and stops after", async () => {
    const recorder = new Recorder();
    await run({ maxPings: 50 }, recorder, INTERVAL * 3.5);
    const pings = recorder.pings.length;
    expect(pings).toBeGreaterThanOrEqual(2);
    expect(pings).toBeLessThanOrEqual(4);
    await sleep(INTERVAL * 3);
    expect(recorder.pings).toHaveLength(pings);
  });

  it("resends the same request with one output token, tagged nostream", async () => {
    const recorder = new Recorder();
    await run({}, recorder, INTERVAL * 1.5);
    const [original, ping] = recorder.calls;
    expect(ping.messages).toBe(original.messages);
    expect(ping.modelSettings).toEqual({
      ...original.modelSettings,
      tags: ["nostream", "cache_keepalive"],
    });
    expect(ping.model.maxTokens).toBe(1);
    expect(ping.model.streaming).toBe(false);
    expect(ping.model.disableStreaming).toBe(true);
    expect(ping.model.getName()).toBe("ChatAnthropic");
    expect(original.model.maxTokens).toBeUndefined();
  });

  it("sends no ping for a short tool", async () => {
    const recorder = new Recorder();
    await run({}, recorder, INTERVAL / 5);
    expect(recorder.pings).toEqual([]);
  });

  it("caps a hung tool at maxPings", async () => {
    const recorder = new Recorder();
    await run({ maxPings: 2 }, recorder, INTERVAL * 6);
    expect(recorder.pings).toHaveLength(2);
  });

  it("stops pinging after a failed ping and the tool still returns", async () => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const recorder = new Recorder(["t1"], { failPings: true });
    const result = await run({}, recorder, INTERVAL * 4);
    expect((result as ToolMessage).content).toBe("done");
    expect(recorder.pings).toHaveLength(1);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("does not ping budgeted thinking and warns once", async () => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const mw = anthropicCacheKeepaliveMiddleware({ interval: INTERVAL });
    const recorder = new Recorder();
    const thinking = { type: "enabled", budget_tokens: 2048 };
    for (let i = 0; i < 2; i += 1) {
      await mw.wrapModelCall!(modelRequest(true, thinking), recorder.handler);
      await mw.wrapToolCall!(
        toolRequest("t1"),
        slowTool(() => INTERVAL * 3),
      );
      recorder.calls.splice(0);
    }
    expect(recorder.pings).toHaveLength(0);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("pings adaptive thinking", async () => {
    const recorder = new Recorder();
    await run({}, recorder, INTERVAL * 1.5, true, { type: "adaptive" });
    expect(recorder.pings).toHaveLength(1);
  });

  it("does not ping a non-Anthropic model", async () => {
    const recorder = new Recorder();
    await run({}, recorder, INTERVAL * 3, false);
    expect(recorder.pings).toEqual([]);
  });

  it("shares one ping loop across parallel tool calls", async () => {
    const mw = anthropicCacheKeepaliveMiddleware({
      interval: INTERVAL,
      maxPings: 50,
    });
    const recorder = new Recorder(["a", "b"]);
    await mw.wrapModelCall!(modelRequest(), recorder.handler);
    const tool = slowTool((id) => INTERVAL * (id === "b" ? 3.5 : 0.5));
    await Promise.all([
      mw.wrapToolCall!(toolRequest("a"), tool),
      mw.wrapToolCall!(toolRequest("b"), tool),
    ]);
    expect(recorder.pings.length).toBeGreaterThanOrEqual(2);
    expect(recorder.pings.length).toBeLessThanOrEqual(4);
  });

  it("passes an unknown tool call through", async () => {
    const mw = anthropicCacheKeepaliveMiddleware({ interval: INTERVAL });
    const result = await mw.wrapToolCall!(
      toolRequest("missing"),
      (r: any) =>
        new ToolMessage({ content: "ok", tool_call_id: r.toolCall.id }),
    );
    expect((result as ToolMessage).content).toBe("ok");
  });

  describe("pricing", () => {
    it("expected savings is the miss cost minus the ping cost", () => {
      // 50k tokens: a miss costs 50k * ($5 - $0.20) / 1M = $0.24, a ping 50k * $0.20 / 1M = $0.01.
      expect(expectedCacheSavings(OPUS_PRICING, 50_000)).toBeCloseTo(0.23);
    });

    it("skips pings for a small prompt", async () => {
      // Saves about $0.02 per ping, under the $0.05 default.
      const recorder = new Recorder(["t1"], { promptTokens: 5_000 });
      await run({ pricing: OPUS_PRICING }, recorder, INTERVAL * 3);
      expect(recorder.pings).toEqual([]);
    });

    it("keeps pings for a large prompt", async () => {
      const recorder = new Recorder(["t1"], { promptTokens: 50_000 });
      await run({ pricing: OPUS_PRICING }, recorder, INTERVAL * 1.5);
      expect(recorder.pings).toHaveLength(1);
    });

    it("pings when the prompt size is unknown", async () => {
      const recorder = new Recorder();
      await run({ pricing: OPUS_PRICING }, recorder, INTERVAL * 1.5);
      expect(recorder.pings).toHaveLength(1);
    });

    it("minExpectedSavings sets the threshold", async () => {
      const recorder = new Recorder(["t1"], { promptTokens: 5_000 });
      await run(
        { pricing: OPUS_PRICING, minExpectedSavings: 0.01 },
        recorder,
        INTERVAL * 1.5,
      );
      expect(recorder.pings).toHaveLength(1);
    });
  });

  describe("in an agent with ChatAnthropic", () => {
    /** Replays a Messages API reply as the server-sent events of a streamed one. */
    function sseResponse(message: any): Response {
      const { content, stop_reason, usage, ...rest } = message;
      const events: [string, unknown][] = [
        [
          "message_start",
          { message: { ...rest, content: [], stop_reason: null, usage } },
        ],
      ];
      content.forEach((block: any, index: number) => {
        const delta =
          block.type === "text"
            ? { type: "text_delta", text: block.text }
            : {
                type: "input_json_delta",
                partial_json: JSON.stringify(block.input),
              };
        const start =
          block.type === "text"
            ? { ...block, text: "" }
            : { ...block, input: {} };
        events.push(["content_block_start", { index, content_block: start }]);
        events.push(["content_block_delta", { index, delta }]);
        events.push(["content_block_stop", { index }]);
      });
      events.push([
        "message_delta",
        { delta: { stop_reason, stop_sequence: null }, usage },
      ]);
      events.push(["message_stop", {}]);
      const text = events
        .map(
          ([type, data]) =>
            `event: ${type}\ndata: ${JSON.stringify({ type, ...(data as object) })}\n\n`,
        )
        .join("");
      return new Response(text, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }

    /** Answers the Messages API: a tool call first, then empty pings, then "Done". */
    function fakeAnthropicApi() {
      const bodies: any[] = [];
      const fetch = async (_url: unknown, init?: { body?: unknown }) => {
        const body = JSON.parse(String(init?.body));
        bodies.push(body);
        const isPing = body.max_tokens === 0;
        const first = bodies.length === 1;
        const content = isPing
          ? []
          : first
            ? [{ type: "tool_use", id: "t1", name: "slow", input: {} }]
            : [{ type: "text", text: "Done" }];
        const message = {
          id: `msg_${bodies.length}`,
          type: "message",
          role: "assistant",
          model: body.model,
          content,
          stop_reason: isPing ? "max_tokens" : first ? "tool_use" : "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 100, output_tokens: isPing ? 0 : 5 },
        };
        if (body.stream) return sseResponse(message);
        return new Response(JSON.stringify(message), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      };
      return { bodies, fetch };
    }

    class TagRecorder extends BaseCallbackHandler {
      name = "tag-recorder";
      tags: string[][] = [];
      async handleChatModelStart(
        _llm: unknown,
        _messages: unknown,
        _runId: string,
        _parentRunId?: string,
        _extra?: unknown,
        tags?: string[],
      ) {
        this.tags.push(tags ?? []);
      }
    }

    it("sends max_tokens 1 without streaming and keeps pings out of the messages stream", async () => {
      const api = fakeAnthropicApi();
      const model = new ChatAnthropic({
        model: "claude-opus-5-5",
        apiKey: "fake",
        maxRetries: 0,
        clientOptions: { fetch: api.fetch as any },
      });
      const slow = tool(
        async () => {
          await sleep(INTERVAL * 1.5);
          return "done";
        },
        { name: "slow", description: "Slow tool", schema: z.object({}) },
      );
      const agent = createAgent({
        model,
        tools: [slow],
        middleware: [
          anthropicCacheKeepaliveMiddleware({
            interval: INTERVAL,
            maxPings: 1,
          }),
        ],
      });
      const tags = new TagRecorder();

      const streamed: string[] = [];
      const stream = await agent.stream(
        { messages: [new HumanMessage("run it")] },
        { streamMode: "messages", callbacks: [tags] },
      );
      for await (const [message] of stream) {
        if (
          AIMessageChunk.isInstance(message) ||
          AIMessage.isInstance(message)
        ) {
          streamed.push(message.id ?? "");
        }
      }

      const [first, ping, last] = api.bodies;
      expect(api.bodies).toHaveLength(3);
      expect(ping.max_tokens).toBe(1);
      expect(ping.stream).toBe(false);
      expect(first.max_tokens).toBeGreaterThan(0);
      expect(first.stream).toBe(true);
      expect(ping.messages).toEqual(first.messages);
      expect(ping.tools).toEqual(first.tools);
      expect(last.messages.length).toBeGreaterThan(first.messages.length);

      expect(tags.tags[1]).toEqual(
        expect.arrayContaining(["nostream", "cache_keepalive"]),
      );
      expect(tags.tags[0]).not.toContain("nostream");
      expect(streamed).not.toContain("msg_2");
    });
  });
});
