---
"deepagents": patch
---

fix(deepagents): preserve model call limits with parallel subagents

Keep model-call counters local to each agent graph so parallel subagents do not
write conflicting updates to the parent graph's state.
