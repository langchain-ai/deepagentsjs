---
"deepagents": patch
---

`StateBackend.read()` and `StoreBackend.read()` now report `EMPTY_CONTENT_WARNING` for an existing but empty text file, matching `FilesystemBackend`. They previously returned an empty string, which made an empty file indistinguishable from a read that produced nothing.
