---
"deepagents": patch
---

fix(deepagents): require `mode: "fork"` on `ForkedSubAgent`

`ForkedSubAgent.mode` was optional, defaulting to being omitted per its own documented example. Since `SubAgent.systemPrompt` is also optional, a `ForkedSubAgent` that omitted `mode` had the same shape as a plain `SubAgent` and silently misrouted between forking and non-forking behavior. `mode: "fork"` is now required on `ForkedSubAgent`, closing the ambiguity.
