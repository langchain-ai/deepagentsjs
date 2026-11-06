---
"deepagents": patch
---

feat(deepagents): record the subagent's checkpoint namespace on the `task` tool message

The `task` tool's `ToolMessage` carries `artifact: { checkpoint_ns }`, the checkpoint namespace the subagent saved under: `tools:<id>`, prefixed by the parent's segments when the deep agent is nested. A client can load a finished subagent's history from that namespace instead of scanning the thread's history.
