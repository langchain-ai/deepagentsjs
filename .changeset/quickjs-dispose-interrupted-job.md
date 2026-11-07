---
"@langchain/quickjs": patch
---

fix(quickjs): free the exception from interrupted pending jobs

When an interrupt or uncaught exception stopped `executePendingJobs`, the returned exception handle was never disposed. Disposing the session then aborted the shared WASM module (`Assertion failed: list_empty(&rt->gc_obj_list) … JS_FreeRuntime`), after which every `tools.*` call in the process returned `undefined`. This happened whenever an eval was interrupted after awaiting a tool and its session was then disposed.
