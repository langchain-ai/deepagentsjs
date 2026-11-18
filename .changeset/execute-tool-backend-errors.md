---
"deepagents": patch
---

The `execute` tool returns an error tool message when the sandbox backend rejects a command, instead of throwing and ending the run. The model sees the backend's error text and can try another command. Interrupts and aborted runs still propagate.
