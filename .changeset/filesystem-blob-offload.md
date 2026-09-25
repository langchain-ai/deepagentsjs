---
"deepagents": patch
---

feat(deepagents): add `offloadBinaryReads` option to `FilesystemMiddleware` to keep binary `read_file` content out of checkpointed message history. When enabled, binary reads are written to the backend under `/blobs` and replaced in state with a small reference; model requests are rehydrated from an in-process cache or the backend.
