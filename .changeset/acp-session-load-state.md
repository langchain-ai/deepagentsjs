---
"deepagents-acp": patch
---

`session/load` reads the thread's messages through the agent's state instead of the raw checkpoint, so it replays the agent's replies and tool calls now that deep agents store messages as deltas. The `@langchain/langgraph` peer floor rises to `^1.6.1`, as in `deepagents`.
