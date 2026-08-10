import { describe, it, expect } from "vitest";
import { Command } from "@langchain/langgraph";
import { ToolMessage } from "@langchain/core/messages";
import { unwrapToolEnvelope } from "./coerce.js";

/** A Command like the deepagents task tool resolves to. */
function command(...contents: unknown[]): Command {
  return new Command({
    update: {
      messages: contents.map(
        (content, i) =>
          new ToolMessage({
            content: content as string,
            tool_call_id: `c${i}`,
          }),
      ),
    },
  });
}

describe("unwrapToolEnvelope", () => {
  it("returns a plain string unchanged", () => {
    expect(unwrapToolEnvelope("just text")).toBe("just text");
  });

  it("returns null and undefined unchanged", () => {
    expect(unwrapToolEnvelope(null)).toBeNull();
    expect(unwrapToolEnvelope(undefined)).toBeUndefined();
  });

  it("unwraps the last message content from a Command envelope", () => {
    const json = JSON.stringify({ root_cause: "race condition" });
    expect(unwrapToolEnvelope(command(json))).toBe(json);
  });

  it("takes the last message when a Command has several", () => {
    expect(unwrapToolEnvelope(command("first", "second", "final"))).toBe(
      "final",
    );
  });

  it("unwraps a bare ToolMessage to its content", () => {
    const message = new ToolMessage({ content: "hello", tool_call_id: "c0" });
    expect(unwrapToolEnvelope(message)).toBe("hello");
  });

  it("unwraps the last ToolMessage from a message list", () => {
    const list = [
      new ToolMessage({ content: "a", tool_call_id: "a" }),
      new ToolMessage({ content: "b", tool_call_id: "b" }),
    ];
    expect(unwrapToolEnvelope(list)).toBe("b");
  });

  it("unwraps a Command nested in a list", () => {
    expect(unwrapToolEnvelope([command("x"), command("y")])).toBe("y");
  });

  it("returns a content-block array unchanged (caller handles text join)", () => {
    const blocks = [
      { type: "text", text: "Hello " },
      { type: "text", text: "world" },
    ];
    expect(unwrapToolEnvelope(blocks)).toBe(blocks);
  });

  it("returns a plain { content } data object unchanged (not a message)", () => {
    const obj = { content: "not-a-message", other: 1 };
    expect(unwrapToolEnvelope(obj)).toBe(obj);
  });

  it("returns a plain object unchanged", () => {
    const obj = { foo: "bar" };
    expect(unwrapToolEnvelope(obj)).toBe(obj);
  });

  it("returns a Command with no message payload unchanged", () => {
    const cmd = new Command({ update: { files: {} } });
    expect(unwrapToolEnvelope(cmd)).toBe(cmd);
  });
});
