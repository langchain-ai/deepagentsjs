---
"deepagents": patch
---

Tool result eviction now treats audio and video blocks like image blocks: they no longer count toward `toolTokenLimitBeforeEvict`, and when a tool result's text is evicted they stay on the replacement message instead of being dropped.
