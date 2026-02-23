---
"deepagents": minor
---

Add `namespace` option to `StoreBackend` for custom store namespace isolation.

- `StoreBackend` now accepts an optional `{ namespace: string[] }` to control where files are stored in the LangGraph store
- Enables user-scoped, org-scoped, or any custom isolation pattern when combined with the `backend` factory on `createDeepAgent`
- Namespace components are validated to prevent wildcard/glob injection
- Defaults to `["filesystem"]` (or `[assistantId, "filesystem"]` when `assistantId` is set) for backwards compatibility
- Added integration tests verifying store propagation via invoke config (cloud deployment simulation)
