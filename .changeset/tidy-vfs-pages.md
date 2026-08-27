---
"@langchain/node-vfs": patch
---

fix(filesystem): return pagination metadata for virtual file reads

Include source ranges, total line counts, and continuation offsets for paginated text reads from the Node VFS backend.
