---
"deepagents": patch
---

Fix tool result eviction dropping media: image, audio and video blocks no longer count toward `toolTokenLimitBeforeEvict`, so a screenshot returned by a tool (for example over MCP) no longer forces eviction on its own, and when a tool result's text is evicted its media blocks stay on the replacement message, as they already do for evicted human messages.
