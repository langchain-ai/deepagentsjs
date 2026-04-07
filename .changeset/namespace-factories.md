---
"deepagents": patch
---

feat(deepagents): add namespace factory support to StoreBackend

`StoreBackendOptions.namespace` now accepts a `NamespaceFactory` function `(runtime: Partial<Runtime>) => string[]` for dynamic, per-invocation namespace resolution (e.g. per-user, per-assistant, per-thread storage isolation).
