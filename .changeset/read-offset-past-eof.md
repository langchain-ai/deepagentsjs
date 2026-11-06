---
"deepagents": patch
---

`StateBackend.read()` and `StoreBackend.read()` now return an error when the line offset is past the end of the file, matching `FilesystemBackend`. They previously returned an empty content string with no pagination metadata, so an out-of-range offset was indistinguishable from an empty file.
