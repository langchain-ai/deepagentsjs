---
"deepagents": patch
---

fix(subagents): support PTC invocation of task tool

Task tool now returns plain string when invoked without a tool call ID (i.e. via programmatic tool calling inside the REPL), instead of throwing.
