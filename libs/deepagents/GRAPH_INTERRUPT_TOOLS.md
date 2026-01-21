# GraphInterrupt from Tools - Issue Analysis and Workaround

## Issue Description

When a tool throws a `GraphInterrupt` in DeepAgents, the error loses its `interrupts` property during propagation through the tool execution chain, causing a TypeError in LangGraph's internal `_commit()` function.

**GitHub Issue:** [#131](https://github.com/langchain-ai/deepagentsjs/issues/131)

## Root Cause

The problem occurs in LangGraph's error serialization code (`pregel/runner.js:171-173`):

```javascript
else this.loop.putWrites(task.id, [[ERROR, {
    message: error.message,
    name: error.name
}]]);
```

When an error that's not caught by earlier checks occurs, LangGraph only preserves the `message` and `name` properties. When the error is later reconstructed, it becomes a plain Error object that passes the `isGraphInterrupt(error)` check (which only examines the `name` property), but lacks the critical `interrupts` array.

## Why This Happens

`interrupt()` and `GraphInterrupt` are designed to be called from graph **nodes**, not from within **tools**. When called from a tool:

1. ✅ Tool constructs `GraphInterrupt` with proper `interrupts` array
2. ✅ Error is thrown from tool
3. ❌ Error is serialized by LangGraph's tool execution layer, losing custom properties
4. ❌ By the time it reaches `_commit()`, the `interrupts` property is undefined
5. ❌ TypeError: `undefined is not an object (evaluating 'error.interrupts.length')`

## Recommended Solution: Use HITL Middleware

DeepAgents already provides a proper solution for tool-level approval workflows through the **Human-in-the-Loop (HITL) middleware**:

```typescript
import { createDeepAgent } from "deepagents";
import { MemorySaver } from "@langchain/langgraph";

const checkpointer = new MemorySaver();

const agent = createDeepAgent({
  tools: [myTool, otherTool],
  interruptOn: {
    my_tool: true,  // Interrupt before executing this tool
    other_tool: { allowedDecisions: ["approve", "reject"] },
  },
  checkpointer,
});

// First invocation - will interrupt before executing my_tool
const result = await agent.invoke({
  messages: [{ role: "user", content: "Use my_tool" }],
}, { configurable: { thread_id: "thread-1" } });

// Check for interrupts
if (result.__interrupt__) {
  const interrupts = result.__interrupt__[0].value;
  // Review interrupts and approve/reject
}

// Resume with approval
const result2 = await agent.invoke(
  new Command({
    resume: {
      decisions: [{ type: "approve" }],
    },
  }),
  { configurable: { thread_id: "thread-1" } }
);
```

## Why HITL Middleware is Better

1. **Designed for Tools**: The HITL middleware is specifically designed to handle interrupts at the tool level
2. **Proper State Management**: Uses LangGraph's checkpointing system correctly
3. **Type-Safe**: Fully typed with proper interrupt handling
4. **Flexible**: Supports approve/reject/edit decisions
5. **Works with Subagents**: Properly propagates interrupt configuration to subagents

## Alternative: Use Command API

If you need custom interrupt data from within a tool, use the Command API:

```typescript
import { tool } from "langchain";
import { Command } from "@langchain/langgraph";
import { ToolMessage } from "@langchain/core/messages";
import { z } from "zod";

const approvalTool = tool(
  async (input, config) => {
    // Instead of throwing GraphInterrupt, return a Command
    return new Command({
      update: {
        messages: [
          new ToolMessage({
            content: `Requesting approval for: ${input.action}`,
            tool_call_id: config.toolCall?.id as string,
          }),
        ],
      },
      // You can add custom interrupt data here if needed
      // Note: This requires setting up proper interrupt handling
    });
  },
  {
    name: "request_approval",
    description: "Request approval for an action",
    schema: z.object({
      action: z.string(),
    }),
  }
);
```

## Upstream Fix Required

The ultimate fix requires changes to LangGraph's error serialization to preserve the `interrupts` property:

**Current code (pregel/runner.js:171-173):**
```javascript
else this.loop.putWrites(task.id, [[ERROR, {
    message: error.message,
    name: error.name
}]]);
```

**Should be:**
```javascript
else if (isGraphInterrupt(error)) this.loop.putWrites(task.id, [[ERROR, {
    message: error.message,
    name: error.name,
    interrupts: error.interrupts  // Preserve interrupts property
}]]);
else this.loop.putWrites(task.id, [[ERROR, {
    message: error.message,
    name: error.name
}]]);
```

## References

- [LangGraph Interrupt Documentation](https://langchain-ai.github.io/langgraphjs/how-tos/human_in_the_loop/)
- [ToolNode doesn't collect all interrupts from parallel tool execution #6624](https://github.com/langchain-ai/langgraph/issues/6624)
- [Interrupt calls in parallel tools generate identical IDs #6626](https://github.com/langchain-ai/langgraph/issues/6626)
