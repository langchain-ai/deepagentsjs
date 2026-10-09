---
"deepagents": patch
---

Mark failed tool results with `status: "error"`. `read_file` returns a backend failure, such as a missing file, as an error `ToolMessage` instead of plain `Error: …` text. The patch tool calls middleware also marks the result it inserts for a tool call that never ran as an error.
