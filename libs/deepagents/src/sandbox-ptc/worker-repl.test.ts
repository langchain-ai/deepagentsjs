import { describe, it, expect } from "vitest";
import { tool } from "langchain";
import { z } from "zod/v4";

import { WorkerRepl } from "./worker-repl.js";

describe("WorkerRepl", { timeout: 15_000 }, () => {
  it("should evaluate simple JS and return output", async () => {
    const repl = new WorkerRepl([]);
    const result = await repl.eval('console.log("hello from worker")');

    expect(result.output).toContain("hello from worker");
    expect(result.exitCode).toBe(0);
    expect(result.toolCalls).toEqual([]);
  });

  it("should return the last expression value via console.log", async () => {
    const repl = new WorkerRepl([]);
    const result = await repl.eval("const x = 2 + 3;\nconsole.log(x)");

    expect(result.output).toContain("5");
    expect(result.exitCode).toBe(0);
  });

  it("should handle errors gracefully", async () => {
    const repl = new WorkerRepl([]);
    const result = await repl.eval("throw new Error('boom')");

    expect(result.output).toContain("boom");
    expect(result.exitCode).toBe(1);
  });

  it("should perform a single toolCall round-trip", async () => {
    const greetTool = tool(
      async (input: { name: string }) => `Hello, ${input.name}!`,
      {
        name: "greet",
        description: "Greet someone",
        schema: z.object({ name: z.string() }),
      },
    );

    const repl = new WorkerRepl([greetTool]);
    const result = await repl.eval(`
      const msg = await toolCall("greet", { name: "World" });
      console.log("GOT: " + msg);
    `);

    expect(result.output).toContain("GOT: Hello, World!");
    expect(result.exitCode).toBe(0);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].name).toBe("greet");
    expect(result.toolCalls[0].result).toBe("Hello, World!");
    expect(result.toolCalls[0].error).toBeUndefined();
    expect(result.toolCalls[0].durationMs).toBeGreaterThanOrEqual(0);
  });

  it("should handle parallel toolCalls via Promise.all", async () => {
    const echoTool = tool(async (input: { id: number }) => `echo-${input.id}`, {
      name: "echo",
      description: "Echo an id",
      schema: z.object({ id: z.number() }),
    });

    const repl = new WorkerRepl([echoTool]);
    const result = await repl.eval(`
      const ids = [1, 2, 3, 4, 5];
      const results = await Promise.all(
        ids.map(id => toolCall("echo", { id }))
      );
      console.log("results: " + results.join(","));
    `);

    expect(result.output).toContain(
      "results: echo-1,echo-2,echo-3,echo-4,echo-5",
    );
    expect(result.exitCode).toBe(0);
    expect(result.toolCalls).toHaveLength(5);
  });

  it("should handle tool call errors", async () => {
    const failTool = tool(
      async () => {
        throw new Error("intentional failure");
      },
      {
        name: "fail",
        description: "Always fails",
        schema: z.object({}),
      },
    );

    const repl = new WorkerRepl([failTool]);
    const result = await repl.eval(`
      try {
        await toolCall("fail", {});
      } catch (e) {
        console.log("caught: " + e.message);
      }
    `);

    expect(result.output).toContain("caught: intentional failure");
    expect(result.exitCode).toBe(0);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].error).toContain("intentional failure");
  });

  it("should handle unknown tool names", async () => {
    const repl = new WorkerRepl([]);
    const result = await repl.eval(`
      try {
        await toolCall("nonexistent", {});
      } catch (e) {
        console.log("caught: " + e.message);
      }
    `);

    expect(result.output).toContain("caught: Unknown tool: nonexistent");
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].error).toContain("Unknown tool: nonexistent");
  });

  it("should handle spawnAgent", async () => {
    const taskTool = tool(
      async (input: { description: string; subagent_type: string }) =>
        `Analysed: ${input.description.slice(0, 30)} (agent=${input.subagent_type})`,
      {
        name: "task",
        description: "Spawn a subagent",
        schema: z.object({
          description: z.string(),
          subagent_type: z.string(),
        }),
      },
    );

    const repl = new WorkerRepl([taskTool]);
    const result = await repl.eval(`
      const analysis = await spawnAgent("Review quarterly data", "analyst");
      console.log("AGENT: " + analysis);
    `);

    expect(result.output).toContain("AGENT: Analysed: Review quarterly data");
    expect(result.output).toContain("agent=analyst");
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].name).toBe("task");
  });

  it("should block access to require, process, and fs (vm sandbox)", async () => {
    const repl = new WorkerRepl([]);

    const r1 = await repl.eval('try { require("fs"); console.log("FAIL: require accessible"); } catch(e) { console.log("OK: " + e.message); }');
    expect(r1.output).toContain("OK:");
    expect(r1.output).not.toContain("FAIL");

    const r2 = await repl.eval('try { console.log("env=" + process.env.HOME); console.log("FAIL: process accessible"); } catch(e) { console.log("OK: " + e.message); }');
    expect(r2.output).toContain("OK:");
    expect(r2.output).not.toContain("FAIL");

    const r3 = await repl.eval('try { const f = globalThis; console.log("globalThis=" + typeof f); } catch(e) { console.log("OK: " + e.message); }');
    expect(r3.output).not.toContain("object");
  });

  it("should timeout long-running code", async () => {
    const repl = new WorkerRepl([], { timeoutMs: 500 });
    const result = await repl.eval(`
      await new Promise(r => setTimeout(r, 10000));
    `);

    expect(result.output).toContain("timed out");
    expect(result.exitCode).toBe(1);
  });
});
