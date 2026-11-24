---
"deepagents": patch
---

fix(deepagents): make the placeholder `ToolMessage` for a tool call with no recorded result cause-neutral, so it no longer claims another message cancelled the call when a run was stopped or restarted mid-tool
