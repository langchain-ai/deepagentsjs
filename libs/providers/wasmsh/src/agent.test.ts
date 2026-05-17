/**
 * Deterministic agent integration test.
 *
 * The other agent tests (`sandbox-agent.int.test.ts`) drive a real LLM via
 * Anthropic and a real Pyodide sandbox; they're slow, gated on assets +
 * `ANTHROPIC_API_KEY`, and not reproducible bit-for-bit.
 *
 * This file does the opposite: it wires `createDeepAgent` to a scripted
 * chat model that emits a pre-decided sequence of `AIMessage`s (one with a
 * `py_eval` tool call, one with the final text), and stubs the sandbox so
 * the test runs offline and finishes in milliseconds. It pins the
 * end-to-end shape of `LLM → middleware → sandbox.runPtc → envelope →
 * model` so a regression in any wire-up step gets caught here without
 * needing the LLM round-trip.
 */
import { describe, it, expect, vi } from "vitest";
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import type { BaseMessage } from "@langchain/core/messages";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type {
  BaseChatModelCallOptions,
  BaseChatModelParams,
} from "@langchain/core/language_models/chat_models";
import type { CallbackManagerForLLMRun } from "@langchain/core/callbacks/manager";
import type { ChatResult } from "@langchain/core/outputs";
import { createDeepAgent } from "deepagents";
import { createWasmshInterpreterMiddleware } from "./middleware.js";
import type { WasmshSandbox } from "./sandbox.js";

/**
 * A chat model that hands back one prebuilt `AIMessage` per call,
 * advancing through the scripted list in order. Unlike
 * `FakeStreamingChatModel.responses` (which returns the same head element
 * every time), this lets us script a tool-call → final-answer sequence
 * deterministically.
 */
class ScriptedChatModel extends BaseChatModel<BaseChatModelCallOptions> {
  #script: AIMessage[];
  #cursor = 0;
  capturedMessages: BaseMessage[][] = [];

  constructor(script: AIMessage[], rest: BaseChatModelParams = {}) {
    super(rest);
    this.#script = script;
  }

  _llmType(): string {
    return "scripted-fake";
  }

  bindTools(_tools: unknown): typeof this {
    // The scripted responses are fully prebuilt, so we don't actually use
    // the tool schemas — but createAgent will call `bindTools` regardless
    // and expect a chat model back.
    return this;
  }

  async _generate(
    messages: BaseMessage[],
    _options: this["ParsedCallOptions"],
    _runManager?: CallbackManagerForLLMRun,
  ): Promise<ChatResult> {
    this.capturedMessages.push([...messages]);
    if (this.#cursor >= this.#script.length) {
      throw new Error(
        `ScriptedChatModel exhausted after ${this.#cursor} call(s)`,
      );
    }
    const message = this.#script[this.#cursor++];
    return {
      generations: [{ text: String(message.content ?? ""), message }],
    };
  }
}

class RecordingSandbox {
  runPtcCalls: Array<{ code: string; tools: string[] }> = [];

  async runPtc(params: {
    code: string;
    tools?: string[];
    onHostCall?: unknown;
  }) {
    this.runPtcCalls.push({ code: params.code, tools: params.tools ?? [] });
    return { ok: true as const, stdout: "42\n", stderr: "", value: 42 };
  }
}

describe("createDeepAgent + WasmshInterpreterMiddleware (scripted LLM)", () => {
  it("routes a py_eval tool call to sandbox.runPtc and threads the envelope back to the model", async () => {
    const sandbox = new RecordingSandbox();
    const middleware = createWasmshInterpreterMiddleware({
      sandboxFactory: async () => sandbox as unknown as WasmshSandbox,
    });

    // First turn: model asks for `py_eval(code="2 * 21")`.
    // Second turn: model emits the final answer (no tool calls), ending the loop.
    const toolCallId = "call_42";
    const turn1 = new AIMessage({
      content: "",
      tool_calls: [
        {
          id: toolCallId,
          name: "py_eval",
          args: { code: "2 * 21" },
        },
      ],
    });
    const turn2 = new AIMessage({ content: "The answer is 42." });
    const model = new ScriptedChatModel([turn1, turn2]);

    const agent = createDeepAgent({
      model,
      middleware: [middleware],
    });

    const result = await agent.invoke({
      messages: [new HumanMessage("compute 2 * 21")],
    });

    // The sandbox was invoked with the code the model emitted.
    expect(sandbox.runPtcCalls).toHaveLength(1);
    expect(sandbox.runPtcCalls[0].code).toBe("2 * 21");

    // The middleware fed the eval envelope back to the model as a
    // ToolMessage; the second model call saw it in its message history.
    expect(model.capturedMessages).toHaveLength(2);
    const secondCallMessages = model.capturedMessages[1];
    const toolMessage = secondCallMessages.find(
      (m): m is ToolMessage =>
        typeof (m as { _getType?: () => string })._getType === "function" &&
        (m as { _getType: () => string })._getType() === "tool",
    );
    expect(toolMessage).toBeDefined();
    expect(toolMessage!.tool_call_id).toBe(toolCallId);
    // The eval result (`value: 42`, `stdout: "42\n"`) round-trips through
    // the middleware's formatter into the ToolMessage content.
    const toolContent =
      typeof toolMessage!.content === "string"
        ? toolMessage!.content
        : JSON.stringify(toolMessage!.content);
    expect(toolContent).toContain("42");

    // The final state's last message is the model's text answer.
    const last = result.messages.at(-1) as BaseMessage;
    expect(typeof last.content === "string" ? last.content : "").toContain(
      "42",
    );
  });

  it("propagates a sandbox runtime error through the middleware as a ToolMessage", async () => {
    // Sandbox returns an error envelope (e.g. Python raised NameError). The
    // middleware must format it as a tool message the next turn can see.
    const sandbox = {
      async runPtc() {
        return {
          ok: false as const,
          stdout: "",
          stderr: "",
          error: "NameError",
          message: "name 'undef' is not defined",
        };
      },
    };
    const middleware = createWasmshInterpreterMiddleware({
      sandboxFactory: async () => sandbox as unknown as WasmshSandbox,
    });

    const toolCallId = "call_err";
    const turn1 = new AIMessage({
      content: "",
      tool_calls: [
        {
          id: toolCallId,
          name: "py_eval",
          args: { code: "undef" },
        },
      ],
    });
    const turn2 = new AIMessage({ content: "Saw the error." });
    const model = new ScriptedChatModel([turn1, turn2]);

    const agent = createDeepAgent({
      model,
      middleware: [middleware],
    });

    await agent.invoke({
      messages: [new HumanMessage("trigger an error")],
    });

    expect(model.capturedMessages).toHaveLength(2);
    const second = model.capturedMessages[1];
    const toolMsg = second.find(
      (m): m is ToolMessage =>
        typeof (m as { _getType?: () => string })._getType === "function" &&
        (m as { _getType: () => string })._getType() === "tool",
    );
    expect(toolMsg).toBeDefined();
    const content =
      typeof toolMsg!.content === "string"
        ? toolMsg!.content
        : JSON.stringify(toolMsg!.content);
    expect(content).toContain("NameError");
    expect(content).toContain("name 'undef' is not defined");
  });

  it("does not call sandbox.runPtc when the model produces no tool calls", async () => {
    // Smoke check: confirms the middleware doesn't trigger an eval on its
    // own — the model has to actually request `py_eval`.
    const sandbox = new RecordingSandbox();
    const runPtcSpy = vi.spyOn(sandbox, "runPtc");
    const middleware = createWasmshInterpreterMiddleware({
      sandboxFactory: async () => sandbox as unknown as WasmshSandbox,
    });

    const model = new ScriptedChatModel([
      new AIMessage({ content: "Nothing to compute." }),
    ]);
    const agent = createDeepAgent({
      model,
      middleware: [middleware],
    });

    await agent.invoke({ messages: [new HumanMessage("hi")] });
    expect(runPtcSpy).not.toHaveBeenCalled();
  });
});
