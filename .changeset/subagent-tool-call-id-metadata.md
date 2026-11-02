---
"deepagents": patch
---

feat(deepagents): pass the `task` call id to subagents as `lc_subagent_tool_call_id`

The `task` tool adds `lc_subagent_tool_call_id` to the subagent's config metadata, so traces, stream events and checkpointers that copy config metadata can tie a subagent back to the call that started it.
