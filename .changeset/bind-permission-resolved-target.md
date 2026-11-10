---
"deepagents": patch
---

fix(deepagents): run file operations on the path the permission check resolved

`read_file`, `write_file`, `edit_file` and `delete` now hand the backend the symlink-resolved path that was checked, so swapping an intermediate symlink between the check and the operation can no longer reach a denied target.
