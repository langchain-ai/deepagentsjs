---
"deepagents": patch
---

Fix a declarative subagent silently getting no tools when it omitted its own `tools` field (now correctly falls back to the parent's tools, as documented), and make `createDeepAgent` throw at construction if two subagents share a name instead of silently letting the later one win. Also drop the separate `ForkedSubAgent` type — `mode: "fork"` is now just a value on `SubAgent` — and allow a fork to declare its own `systemPrompt`, appended to the parent's inherited prompt instead of being rejected.
