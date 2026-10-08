---
"deepagents": patch
---

Fix summarization argument truncation dropping message fields: when `truncateArgs` rebuilds an `AIMessage` it now preserves `id`, `name`, `response_metadata`, `usage_metadata` and `invalid_tool_calls`, and only rebuilds messages whose own arguments were actually truncated. This keeps `response_metadata.output` intact for OpenAI Responses API reasoning replay, with the truncated arguments written into its `function_call` items so truncation still applies on that path.
