---
"@langchain/node-vfs": minor
---

refactor(node-vfs): remove shell execution from the VFS provider

`VfsBackend` now operates as a filesystem-only `BackendProtocolV2` implementation and no longer exposes command execution.

The provider now implements `read`, `ls`, `grep`, and `glob` directly against the in-memory VFS, and path resolution is confined to the virtual workspace root. `VfsSandbox` remains available as a deprecated alias for backwards compatibility.
