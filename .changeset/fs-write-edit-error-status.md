---
"deepagents": patch
---

`write_file` and `edit_file` now return a `status: "error"` tool message when the backend reports an error, as `delete` already does. Before, the error came back as a plain string, which was recorded as a successful tool call.
