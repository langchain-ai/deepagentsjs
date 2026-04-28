import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  StateGraph,
  StateSchema,
  MemorySaver,
  START,
  END,
} from "@langchain/langgraph";
import { StateBackend } from "./state.js";
import { filesValue } from "../values.js";

const GraphState = new StateSchema({
  files: filesValue,
  result: z.string(),
});

function makeGraph(node: () => Promise<{ result: string }>) {
  return new StateGraph(GraphState)
    .addNode("test", node)
    .addEdge(START, "test")
    .addEdge("test", END)
    .compile({ checkpointer: new MemorySaver() });
}

describe("StateBackend integration (real LangGraph graph)", () => {
  it("write-then-read in same node sees pending write", async () => {
    const graph = makeGraph(async () => {
      const backend = new StateBackend();
      backend.write("/hello.txt", "world");
      const read = backend.read("/hello.txt");
      return { result: read.error ?? String(read.content) };
    });

    const result = await graph.invoke(
      {},
      { configurable: { thread_id: crypto.randomUUID() } },
    );
    expect(result.result).toBe("world");
  });

  it("write-edit-read in same node sees edited content", async () => {
    const graph = makeGraph(async () => {
      const backend = new StateBackend();
      backend.write("/doc.txt", "hello world");
      backend.edit("/doc.txt", "hello", "goodbye");
      const read = backend.read("/doc.txt");
      return { result: read.error ?? String(read.content) };
    });

    const result = await graph.invoke(
      {},
      { configurable: { thread_id: crypto.randomUUID() } },
    );
    expect(result.result).toBe("goodbye world");
  });

  it("write in node N is visible in node N+1 via committed state", async () => {
    const graph = new StateGraph(GraphState)
      .addNode("write", async () => {
        const backend = new StateBackend();
        backend.write("/cross.txt", "persisted");
        return {};
      })
      .addNode("read", async () => {
        const backend = new StateBackend();
        const read = backend.read("/cross.txt");
        return { result: read.error ?? String(read.content) };
      })
      .addEdge(START, "write")
      .addEdge("write", "read")
      .addEdge("read", END)
      .compile({ checkpointer: new MemorySaver() });
    const result = await graph.invoke(
      {},
      { configurable: { thread_id: crypto.randomUUID() } },
    );
    expect(result.result).toBe("persisted");
  });
});
