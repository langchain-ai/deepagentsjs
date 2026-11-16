---
"deepagents": patch
---

fix(deepagents): stream async subagent runs to apps that join them

The runs that the async subagent tools start on the same deployment, and the run that wakes the parent when a task finishes, now stream like an app's own runs. An app that joins one of these runs sees the reply token by token, including from subgraphs, and can replay events it missed. Subagents with a `url` keep their server's defaults.
