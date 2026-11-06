---
"deepagents": patch
---

feat(deepagents): raise on model refusals by default and report subagent refusals

A model refusal now throws `ModelRefusalError` instead of ending the run as if it succeeded. A subagent's refusal becomes its `task` result, and the main agent keeps going.
