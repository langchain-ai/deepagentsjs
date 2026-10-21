---
"deepagents": patch
---

`StoreBackend.uploadFiles()` and `downloadFiles()` no longer collapse every failure into `invalid_path` / `file_not_found`. A failing store read or write now reports the new `storage_error` code, so a transient infrastructure failure is distinguishable from a bad path or a missing file.
