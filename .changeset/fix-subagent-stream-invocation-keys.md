---
"deepagents": patch
---

fix(stream): isolate subagent projections per task invocation

Key `createSubagentTransformer` channels by `task:${tool_call_id}` instead of
`subagent_type` so parallel same-type subagents no longer share `messages` and
`toolCalls` streams. Closes #560.
