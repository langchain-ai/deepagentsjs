---
"@langchain/quickjs": patch
---

fix(quickjs): count only JS execution against `executionTimeoutMs`

The per-eval budget now counts only time spent running JavaScript, as the Python middleware's `timeout` does. Time spent awaiting `tools.*` or `task()` no longer counts, so an eval that awaits slow tools no longer fails with "Promise timed out — execution interrupted" while a runaway synchronous loop is still interrupted. An eval awaiting a promise that nothing can settle now fails immediately instead of waiting out the budget.

`executionTimeoutMs` therefore no longer bounds an eval's total wall-clock time: time spent awaiting slow tools is uncapped.
