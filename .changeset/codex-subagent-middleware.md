---
"deepagents": patch
---

Add `generalPurposeSubagentMiddleware` so callers can extend the automatically-created general-purpose subagent without reimplementing DeepAgents internals.

Treat unknown-extension UTF-8 files as `text/plain` when reading from the filesystem, while preserving true binary `application/octet-stream` files as binary content.
