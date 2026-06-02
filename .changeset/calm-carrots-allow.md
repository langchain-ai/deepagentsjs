---
"@langchain/node-vfs": minor
---

refactor(node-vfs): remove shell execution from the VFS provider

`VfsSandbox` now operates as a filesystem-only backend. `execute()` is retained for protocol compatibility but returns an unsupported response instead of spawning a host shell process.

The provider now implements `read`, `ls`, `grep`, and `glob` directly against the in-memory VFS, and path resolution is confined to the virtual workspace root.
