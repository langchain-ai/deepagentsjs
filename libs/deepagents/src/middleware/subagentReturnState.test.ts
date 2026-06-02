/**
 * The subagent RETURN path is an allowlist: a subagent writes back only the
 * mergeable channels it accumulates into (`todos`, `files`) plus its final
 * message (handled separately). It must NOT echo inherited parent context
 * (jwt, websiteId, mode, error, …) — N parallel coders each echoing the same
 * channel in one superstep crashes any plain LastValue channel ("LastValue
 * can only receive one value per step"; traces fe0786e3 `error`, fa4945ba
 * `jwt`). Allowlisting kills that class at the source.
 */
import { describe, it, expect } from "vitest";
import { filterReturnState, RETURN_STATE_ALLOWLIST } from "./subagents.js";

describe("filterReturnState", () => {
  it("keeps the mergeable channels a subagent contributes", () => {
    const out = filterReturnState({
      todos: [{ id: "1", content: "x", status: "completed" }],
      files: { "/a.txt": "hi" },
    });
    expect(out).toEqual({
      todos: [{ id: "1", content: "x", status: "completed" }],
      files: { "/a.txt": "hi" },
    });
  });

  it("drops inherited parent context (the fan-in crash sources)", () => {
    const out = filterReturnState({
      jwt: "jwt-abc",
      websiteId: 4,
      mode: "coding",
      accountId: 7,
      error: null,
      todos: [{ id: "1", content: "x", status: "completed" }],
    });
    expect(out).toEqual({
      todos: [{ id: "1", content: "x", status: "completed" }],
    });
    expect(out).not.toHaveProperty("jwt");
    expect(out).not.toHaveProperty("error");
    expect(out).not.toHaveProperty("websiteId");
  });

  it("omits allowlisted keys that are absent (no undefined echoes)", () => {
    expect(filterReturnState({ jwt: "abc" })).toEqual({});
  });

  it("the allowlist is exactly the reducer-backed accumulators", () => {
    expect([...RETURN_STATE_ALLOWLIST]).toEqual(["todos", "files"]);
  });
});
