---
"deepagents": patch
---

The file tools (`ls`, `read_file`, `write_file`, `edit_file`, `delete`, `glob`, `grep`) and `execute` return an error tool message when the backend throws, for example when a sandbox rejects a command or a request times out, instead of ending the run. The model sees the backend's error text and can try something else. Interrupts and aborted runs still propagate. Because these tools no longer throw on a backend error, middleware that retries a tool call only when it throws, such as `toolRetryMiddleware`, no longer retries them for that error.
