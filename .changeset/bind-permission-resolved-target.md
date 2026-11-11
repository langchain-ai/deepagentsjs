---
"deepagents": patch
---

fix(deepagents): bind filesystem permission decisions to the target the operation uses

`read_file`, `write_file`, `edit_file` and `delete` now run on the resolved path that was checked. On Linux, `FilesystemBackend` also holds the parent directory open and makes the final decision on its real location, so swapping a symlink or directory after the check cannot reach a denied target.
