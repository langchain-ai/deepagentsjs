import { describe, it, expect } from "vitest";
import { unwrapToolEnvelope } from "./coerce.js";

/** A Command-shaped value like the deepagents task tool resolves to. */
function command(...contents: unknown[]) {
  return {
    lg_name: "Command",
    update: {
      files: {},
      messages: contents.map((content) => ({ content })),
    },
  };
}

/** A ToolMessage-shaped value (live-instance style). */
function toolMessage(content: unknown) {
  return { content, tool_call_id: "call_1", _getType: () => "tool" };
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

  it("reverse-scans past trailing messages with no content", () => {
    const cmd = {
      update: { messages: [{ content: "real" }, { content: null }, {}] },
    };
    expect(unwrapToolEnvelope(cmd)).toBe("real");
  });

  it("reads serialized message content under kwargs.content", () => {
    const cmd = {
      update: {
        messages: [
          {
            lc: 1,
            type: "constructor",
            id: ["langchain_core", "messages", "ToolMessage"],
            kwargs: { content: "from-kwargs" },
          },
        ],
      },
    };
    expect(unwrapToolEnvelope(cmd)).toBe("from-kwargs");
  });

  it("unwraps a bare ToolMessage to its content", () => {
    expect(unwrapToolEnvelope(toolMessage("hello"))).toBe("hello");
  });

  it("unwraps the last ToolMessage from a message list", () => {
    const list = [toolMessage("a"), toolMessage("b")];
    expect(unwrapToolEnvelope(list)).toBe("b");
  });

  it("unwraps a Command nested inside a message list", () => {
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
    const cmd = { update: { files: {} } };
    expect(unwrapToolEnvelope(cmd)).toBe(cmd);
  });
});
