---
"deepagents": patch
---

fix(subagents): stop forwarding call-count bookkeeping across the subagent boundary

Counters owned by `modelCallLimitMiddleware` and `toolCallLimitMiddleware` used to cross the subagent boundary in both directions, so parallel delegation failed with `InvalidUpdateError` and serial delegation let a subagent's reset rewind the parent's budget, defeating `runLimit`. Each agent now counts only its own calls, and deliberately shared state such as `files` is unaffected. Middleware outside those two can still collide, most notably a `mode: "fork"` subagent combined with parent-side custom middleware.
