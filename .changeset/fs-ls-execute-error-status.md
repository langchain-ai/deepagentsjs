---
"deepagents": patch
---

`ls` now returns a `status: "error"` tool message when the backend reports an error, and so do the two `execute` guards that report execution is not available, matching `write_file`, `edit_file`, `glob` and `grep`. Before, these came back as plain strings, which were recorded as successful tool calls.
