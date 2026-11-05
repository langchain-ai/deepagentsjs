---
"deepagents": patch
---

feat(deepagents): raise on model refusals by default and report subagent refusals to the parent

`createDeepAgent` now adds `modelRefusalMiddleware` to the end of the main agent's and each subagent's middleware stack, so a model refusal throws `ModelRefusalError` instead of ending the run as if it succeeded. A `modelFallbackMiddleware` you pass catches the refusal first. To turn it off, exclude `modelRefusalMiddleware` in a harness profile.

When a subagent's model refuses, the `task` tool returns a notice that says so, with the refusal's category and explanation when the provider gives them, and the main agent keeps going. Async subagents report a refusal the same way.
