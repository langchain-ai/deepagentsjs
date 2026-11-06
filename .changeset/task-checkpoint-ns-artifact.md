---
"deepagents": patch
---

feat(deepagents): record the subagent's checkpoint namespace on the `task` tool message

The `task` tool's `ToolMessage` carries `artifact: { checkpoint_ns }`, the checkpoint namespace the subagent saved under, so a client can load a finished subagent's history without scanning the thread's history. The namespace is usually `tools:<id>`, prefixed by the parent's segments when the deep agent is nested. It is `tools:<id>|1` for a retried `task` call and `tools` for a subagent compiled with `checkpointer: true`. `artifact` is unset when the subagent saved nothing.

To read that namespace, the `task` tool runs a compiled subagent with `stream()` instead of `invoke()`.
