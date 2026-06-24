import type { CompiledGraphType } from "@langchain/langgraph";

/** Type shim for `useStreamContext` — mirrors the server deep agent graph. */
export type Agent = CompiledGraphType;
