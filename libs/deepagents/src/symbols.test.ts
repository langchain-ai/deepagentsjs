import { describe, it, expect, vi } from "vitest";
import { createMiddleware } from "langchain";
import { createSubAgentMiddleware } from "./middleware/index.js";
import {
  setSubagentGraphs,
  getSubagentGraphs,
  setSubagentGraphInjector,
  getSubagentGraphInjector,
} from "./symbols.js";
import { SAMPLE_MODEL } from "./testing/utils.js";

describe("symbols", () => {
  describe("subagent graphs", () => {
    it("getSubagentGraphs returns undefined on plain object", () => {
      expect(getSubagentGraphs({})).toBeUndefined();
    });

    it("round-trips graphs through set/get", () => {
      const obj = {};
      const graphs = { "general-purpose": { invoke: vi.fn() } as any };
      setSubagentGraphs(obj, graphs);
      expect(getSubagentGraphs(obj)).toBe(graphs);
    });

    it("overwrites on second set", () => {
      const obj = {};
      const g1 = { a: { invoke: vi.fn() } as any };
      const g2 = { b: { invoke: vi.fn() } as any };
      setSubagentGraphs(obj, g1);
      setSubagentGraphs(obj, g2);
      expect(getSubagentGraphs(obj)).toBe(g2);
    });

    it("does not bleed between objects", () => {
      const a = {};
      const b = {};
      setSubagentGraphs(a, { x: { invoke: vi.fn() } as any });
      expect(getSubagentGraphs(b)).toBeUndefined();
    });
  });

  describe("subagent graph injector", () => {
    it("getSubagentGraphInjector returns undefined on plain object", () => {
      expect(getSubagentGraphInjector({})).toBeUndefined();
    });

    it("round-trips injector through set/get", () => {
      const obj = {};
      const injector = vi.fn();
      setSubagentGraphInjector(obj, injector);
      expect(getSubagentGraphInjector(obj)).toBe(injector);
    });

    it("injector is callable after retrieval", () => {
      const obj = {};
      const received: unknown[] = [];
      setSubagentGraphInjector(obj, (graphs) => received.push(graphs));

      const graphs = { "general-purpose": { invoke: vi.fn() } as any };
      getSubagentGraphInjector(obj)!(graphs);
      expect(received).toHaveLength(1);
      expect(received[0]).toBe(graphs);
    });

    it("does not bleed between objects", () => {
      const a = {};
      const b = {};
      setSubagentGraphInjector(a, vi.fn());
      expect(getSubagentGraphInjector(b)).toBeUndefined();
    });
  });

  describe("createSubAgentMiddleware attaches graphs", () => {
    it("exposes compiled graphs via getSubagentGraphs", () => {
      const middleware = createSubAgentMiddleware({
        defaultModel: SAMPLE_MODEL,
        subagents: [],
      });
      const graphs = getSubagentGraphs(middleware);
      expect(graphs).toBeDefined();
      expect(typeof graphs).toBe("object");
      expect("general-purpose" in graphs!).toBe(true);
    });

    it("graphs object is not empty", () => {
      const middleware = createSubAgentMiddleware({
        defaultModel: SAMPLE_MODEL,
        subagents: [],
      });
      const graphs = getSubagentGraphs(middleware);
      expect(Object.keys(graphs!).length).toBeGreaterThan(0);
    });
  });

  describe("injection bridge", () => {
    it("injector receives graphs attached to source middleware", () => {
      const source = createSubAgentMiddleware({
        defaultModel: SAMPLE_MODEL,
        subagents: [],
      });

      const received: unknown[] = [];
      const target = createMiddleware({ name: "test", tools: [] });
      setSubagentGraphInjector(target, (graphs) => received.push(graphs));

      const compiledGraphs = getSubagentGraphs(source);
      getSubagentGraphInjector(target)?.(compiledGraphs!);

      expect(received).toHaveLength(1);
      expect(received[0]).toBe(compiledGraphs);
    });

    it("skips middleware without an injector", () => {
      const source = createSubAgentMiddleware({
        defaultModel: SAMPLE_MODEL,
        subagents: [],
      });
      const compiledGraphs = getSubagentGraphs(source)!;

      const noInjector = createMiddleware({ name: "no-injector", tools: [] });
      expect(() =>
        getSubagentGraphInjector(noInjector)?.(compiledGraphs),
      ).not.toThrow();
    });
  });
});
