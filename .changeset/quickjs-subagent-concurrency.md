---
"@langchain/quickjs": minor
---

Add `maxSubagentConcurrency` to configure the interpreter's per-REPL `task()` concurrency cap, retaining the default of 32. The prompt reflects the configured limit and treats batching around 10 as advisory.
