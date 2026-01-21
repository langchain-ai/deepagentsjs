---
"deepagents": patch
---

Document GraphInterrupt limitation when thrown from tools and provide recommended solution

## Issue

When a tool throws a `GraphInterrupt`, the error loses its `interrupts` property during error propagation through LangGraph's tool execution chain. This is due to LangGraph's error serialization code (pregel/runner.js:171-173) only preserving `{message, name}` properties, causing a TypeError when `_commit()` tries to access `error.interrupts.length`.

Root cause: `interrupt()` and `GraphInterrupt` are designed to be called from graph **nodes**, not from within **tools**.

## Solution

Use the existing HITL (Human-in-the-Loop) middleware with `interruptOn` configuration:

```typescript
const agent = createDeepAgent({
  tools: [myTool],
  interruptOn: {
    my_tool: true,  // Interrupt before executing this tool
  },
  checkpointer: new MemorySaver(),
});
```

## Changes

- Added integration test demonstrating the issue and recommended solution
- Created GRAPH_INTERRUPT_TOOLS.md documentation explaining the limitation and workarounds
- Test includes both a skipped test showing the issue and a working test showing the HITL middleware solution

## Related

- GitHub Issue #131: https://github.com/langchain-ai/deepagentsjs/issues/131
- Upstream LangGraph issues: #6624, #6626
