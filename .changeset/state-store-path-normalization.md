---
"deepagents": patch
---

`StateBackend` and `StoreBackend` now canonicalise file paths, so a relative path such as `notes.txt` is stored as `/notes.txt` and is visible to `ls()`, `glob()`, and `grep()` instead of becoming an unreachable entry.
