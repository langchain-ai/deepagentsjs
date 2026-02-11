---
"deepagents": patch
---

refactor(summarization): state rework, move to wrap pattern

Refactors `createSummarizationMiddleware` to use the `wrapModelCall` hook instead of `beforeModel`. Instead of rewriting LangGraph state with `RemoveMessage(REMOVE_ALL_MESSAGES)` on each summarization, the middleware now tracks a `SummarizationEvent` in private state and reconstructs the effective message list on each call, avoiding full state rewrites. Supports chained summarizations with correct cutoff index progression.
