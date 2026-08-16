---
"deepagents": minor
---

feat(deepagents): add per-subagent `recursionLimit` override

The `SubAgent` interface now accepts an optional `recursionLimit` field that
overrides the parent agent's ambient recursion limit for that specific subagent.
This allows bounding expensive delegation or giving research-heavy subagents
more headroom independently of the parent's ceiling.
