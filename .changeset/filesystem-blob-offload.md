---
"deepagents": patch
---

feat(deepagents): add `offloadBinaryContent` option to `FilesystemMiddleware` to keep binary `read_file` content and inline `HumanMessage` media out of checkpointed message history. When enabled, payloads are written to the backend under `/blobs` and replaced in state with a small reference; model requests are rehydrated from a per-run cache or the backend.
