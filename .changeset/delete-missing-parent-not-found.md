---
"deepagents": patch
---

fix(deepagents): `FilesystemBackend.delete()` now returns "not found" instead of a raw ENOENT error when a parent directory of the target is missing in virtual mode
