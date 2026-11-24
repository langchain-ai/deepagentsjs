---
"deepagents": minor
---

Remove the experimental v3 streaming types and the `streamTransformers` option.

The v3 event stream (`streamEvents(..., { version: "v3" })`) was documented as experimental, and `langchain` 1.6.8 deprecated it. deepagents no longer layers its own types and options on top of it:

- `DeepAgentRunStream` and `SubagentRunStream` are no longer exported from `deepagents`. If you still need them, import `AgentRunStream` and `SubagentRunStream` from `langchain` while it ships them.
- `createDeepAgent` no longer accepts `streamTransformers`. TypeScript rejects the option, and plain JavaScript callers get it ignored.
- `agent.streamEvents(..., { version: "v3" })` still runs. It now has the return type of langchain's `ReactAgent`, so `run.subagents` is no longer narrowed to the declared subagents, and `run.toolCalls` is typed from the `tools` option alone. Built-in tools such as `task` still arrive at run time but are no longer part of that type, and with no custom tools the element type is `never`. Annotate the run as langchain's `AgentRunStream` (`const run: AgentRunStream = await agent.streamEvents(...)`) to read every call with `name: string`.
- The `TStreamTransformers` type parameter is removed from `createDeepAgent`, `CreateDeepAgentParams` and `DeepAgentTypeConfig`. On `createDeepAgent` and `CreateDeepAgentParams` it was the 6th of 8, so `TStateSchema` and `TSkills` each move up one position, and code that passes six or more explicit type arguments has to drop the sixth. On `DeepAgentTypeConfig` it was the 7th and last.

To follow subagents, use `agent.stream()` with `streamMode` and `subgraphs: true`. Each subagent's chunks arrive under its own `tools:<id>` namespace, with the subagent's name as `lc_agent_name` in the message metadata:

```ts
for await (const [namespace, mode, data] of await agent.stream(input, {
  streamMode: ["messages", "updates"],
  subgraphs: true,
})) {
  if (mode === "messages" && namespace.length > 0) {
    const [message, metadata] = data;
    console.log(namespace[0], metadata.lc_agent_name, message.text);
  }
}
```

The `@langchain/langgraph-sdk` peer range now also accepts 2.x from 2.0.1. The 2.0.0 on npm is a deprecated build and stays excluded.
