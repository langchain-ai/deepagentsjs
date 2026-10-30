---
"@langchain/quickjs": patch
---

feat(quickjs): allow disabling the per-call `executionTimeoutMs`

`createCodeInterpreterMiddleware({ executionTimeoutMs: null })` disables the per-call deadline, and the system prompt now says "No per-call timeout" instead of rendering a negative or infinite number. Zero and `NaN` are rejected.
