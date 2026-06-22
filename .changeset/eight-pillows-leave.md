---
"deepagents": patch
---

fix(deepagents): forward subagent results as text

Fixed a 400 `invalid_request_error` that occurred when a subagent used an Anthropic server-side tool (web search, web fetch, or code execution): the subagent's `server_tool_use`/`*_tool_result` blocks were forwarded to the parent agent as `tool_result` content, which the API rejects. Subagent results are now passed back to the parent as their text content (matching the Python implementation), which resolves the error and also handles a trailing empty `end_turn` message.
