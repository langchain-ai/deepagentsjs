---
"deepagents": patch
---

fix(deepagents): prevent stack overflow in CompositeBackend grep/glob on huge result sets, and add a grep match-count cap

`CompositeBackend` accumulated merged `ls`/`grep`/`glob` results with `push(...entries)`, which passes every entry as a separate function argument and overflows the call stack (RangeError: Maximum call stack size exceeded) when a broad search over a large tree returns hundreds of thousands of entries. Results are now accumulated with a plain loop, so no result-set size can overflow the stack.

`grep` also gains an optional `maxCount` (backend) / `max_count` (tool) cap, mirroring the Python SDK. When the cap is hit, results are flagged `truncated: true` on `GrepResult`/`GlobResult` and the grep tool appends a note telling the model to narrow the search. The cap defaults to 1000 via the `grepMaxCount` middleware option (set to `null` to disable). `CompositeBackend` splits the budget across routed backends and OR-propagates the `truncated` flag on merged results.
