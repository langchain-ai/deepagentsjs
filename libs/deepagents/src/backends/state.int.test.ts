import { describe, it, expect } from "vitest";
import {
  Annotation,
  StateGraph,
  MemorySaver,
  START,
  END,
} from "@langchain/langgraph";
import { StateBackend } from "./state.js";
import type { FileData } from "./protocol.js";

const GraphState = Annotation.Root({
  files: Annotation<Record<string, FileData>>({
    reducer: (a, b) => ({ ...a, ...b }),
    default: () => ({}),
  }),
  result: Annotation<string>({
    reducer: (_, b) => b,
    default: () => "",
  }),
});

function makeGraph(node: () => Promise<{ result: string }>) {
  const builder = new StateGraph(GraphState);
  builder.addNode("test", node);
  builder.addEdge(START, "test");
  builder.addEdge("test", END);
  return builder.compile({ checkpointer: new MemorySaver() });
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
    const builder = new StateGraph(GraphState);

    builder.addNode("write", async () => {
      const backend = new StateBackend();
      backend.write("/cross.txt", "persisted");
      return {};
    });

    builder.addNode("read", async () => {
      const backend = new StateBackend();
      const read = backend.read("/cross.txt");
      return { result: read.error ?? String(read.content) };
    });

    builder.addEdge(START, "write");
    builder.addEdge("write", "read");
    builder.addEdge("read", END);

    const graph = builder.compile({ checkpointer: new MemorySaver() });
    const result = await graph.invoke(
      {},
      { configurable: { thread_id: crypto.randomUUID() } },
    );
    expect(result.result).toBe("persisted");
  });
});
