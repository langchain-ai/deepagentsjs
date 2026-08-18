---
"deepagents": patch
---

fix(deepagents): cap sandbox glob find so root searches cannot OOM the host

Recursive glob listed every path under the search root (and with `-L` could loop through `/proc/*/root`). Prune virtual filesystems and soft-cap find output so a `glob("**/x", "/")` cannot exhaust the runtime heap.
