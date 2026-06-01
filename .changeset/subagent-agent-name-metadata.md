---
"deepagents": patch
---

fix(deepagents): propagate subagent `lc_agent_name` during task delegation

- Ensure `task` tool subagent invocations override `metadata.lc_agent_name` with the selected `subagent_type`.
- Add regression coverage for both compiled subagents (`runnable`) and standard subagent specs to verify tool-time metadata reflects the active subagent.
- Update the `langsmith` peer dependency range in `deepagents` to `^0.7.1`.
