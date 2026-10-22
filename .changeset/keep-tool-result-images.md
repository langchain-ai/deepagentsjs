---
"deepagents": patch
---

`FilesystemMiddleware` no longer counts image blocks toward a tool result's eviction limit, and keeps them in the message when it evicts the result's text.
