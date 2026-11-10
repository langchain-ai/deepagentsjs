---
"@langchain/quickjs": patch
---

fix(quickjs): count only JS execution against `executionTimeoutMs`

The per-eval budget now counts only time spent running JavaScript, as the Python middleware's `timeout` does. Time spent awaiting `tools.*` or `task()` no longer counts, so an eval that awaits slow tools no longer fails with "Promise timed out — execution interrupted" while a runaway synchronous loop is still interrupted. An eval awaiting a promise that nothing can settle now fails immediately instead of waiting out the budget.

`executionTimeoutMs` therefore no longer bounds an eval's total wall-clock time: time spent awaiting slow tools is uncapped.

Host calls are now scoped to the eval that started them, as in the Python middleware. An eval waits for `tools.*` and `task()` calls it started but did not await before returning, and that wait is not counted against the budget. When an eval rejects or runs out of budget, calls still in flight are detached: their results are dropped instead of resuming guest code during a later eval. Evals on one session now run one at a time, since they share its globals, budget and host calls. An eval from a subagent that the same session's `task()` is waiting on fails fast with a "REPL session busy" error instead of waiting for itself. The middleware recognises it from the session key its `task()` dispatch adds to `configurable`. Other concurrent evals queue. An eval queued before the session is disposed fails instead of starting a new runtime.

Disposing a session no longer aborts the shared WASM module (`Assertion failed: list_empty(&rt->gc_obj_list) … JS_FreeRuntime`), after which every later `tools.*` call in the process returned `undefined`. The session now frees everything it holds before the runtime: the exception `executePendingJobs` returns when a job is interrupted, the promise of any host call still in flight, and the promise of an eval that is still running, which then ends with a "Session disposed" error.
