---
"deepagents": patch
---

feat(deepagents): record the subagent's checkpoint namespace on the `task` tool message

For a subagent built from a spec, the `task` tool's `ToolMessage` carries `artifact: { checkpoint_ns }`, the checkpoint namespace the subagent saved under. A client can load a finished subagent's history from that namespace instead of scanning the thread's history. A `CompiledSubAgent` records no namespace.
