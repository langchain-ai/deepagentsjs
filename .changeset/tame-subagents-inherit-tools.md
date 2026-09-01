---
"deepagents": patch
---

Fix a declarative subagent silently getting no tools when it omitted its own `tools` field (now correctly falls back to the parent's tools, as documented), and make `createDeepAgent` throw at construction if two subagents share a name instead of silently letting the later one win.
