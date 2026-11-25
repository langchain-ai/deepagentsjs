---
"deepagents": patch
---

fix(deepagents): report a read offset past EOF as an error in `StateBackend` and `StoreBackend`, matching `FilesystemBackend`, `ContextHubBackend` and the Python backend, instead of returning an empty page.
